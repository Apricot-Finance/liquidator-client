import {consts, ConnWrapper, Parser, pool_id_to_decimal_multiplier} from "@apricot-lend/apricot"
import {Connection, PublicKey, Account} from "@solana/web3.js"
import {Token, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID} from '@solana/spl-token';

// util
async function sleep(ms) {
    await new Promise(resolve => setTimeout(resolve, ms));
}

/*
constantly monitor:
- UserPagesStats: addPage/removePage
- each UsersPage: addUser/removeUser
- each UserInfo: monitor collateral ratio


Note to liquidators: search for TODO. That's where you plug in the call to

wrapper.extern_liquidate(
        liquidator_wallet_account, 
        liquidated_wallet_key, 
        liquidator_collateral_spl,  // SPL token account
        liquidator_borrowed_spl,    // SPL token account
        collateral_mint_str,        // e.g.: btc_mint.toString()
        borrowed_mint_str,          // e.g.: usdc_mint.toString()
        min_collateral_amount,
        repaid_borrow_amount,
    ) {}

*/

let connection = new Connection("https://api.devnet.solana.com", "finalized");
let wrapper = new ConnWrapper(connection);

console.log(await connection.getRecentBlockhash());
console.log("connected");

const [basePda, _] = await consts.get_base_pda();
const [pricePda, __] = await consts.get_price_pda();

let poolListKey = await consts.get_pool_list_key(basePda);
let poolList = Parser.parsePoolList((await connection.getParsedAccountInfo(poolListKey)).value.data);

// remove a deprecated pool, poolId=5 is a badly configured test pool for fake_usdt_usdc
const skippedPools = [5];

function isDeprecated(poolId) {
    poolId = parseInt(poolId);
    return skippedPools.indexOf(poolId) >= 0;
}

console.log("Found PoolList: ")
console.log(poolList)


class Throttler {
    constructor() {
        this.tasks = [];
    }
    addNext(f) {
        this.tasks.push(f);
    }
    async run() {
        while(true) {
            if(this.tasks.length > 0) {
                const f = this.tasks.shift();
                f();
            }
            // 2 TPS
            await sleep(500);
        }
    }
}

const throttler = new Throttler();
throttler.run();

class AccountWatcher {
    constructor(connection) {
        this.watchedKey = null;
        this.value = null;
        this.connection = connection;
        this.children = {}
    }
    init(watchedKey) {
        this.watchedKey = watchedKey;
        throttler.addNext(() => {
            connection.getAccountInfo(watchedKey).then((value) => {
                this.onUpdate(value);
            });
            // FIXME: obviously at the time we get notified the transaction is not yet FINALIZED. Need to figure out why
            // If we can't find a fix, we need to delay the call to this.onUpdate(value) by 20s (which seems to do the
            // trick)
            this.subId = connection.onAccountChange(watchedKey, (value, ctx) => {
                this.onUpdate(value);
            }, "finalized");
        });
    }
    unsub(connection) {
        connection.removeAccountChangeListener(this.subId);
        Object.values(this.children).map(child => child.unsub());
    }
    onUpdate(value) {
        throw new Error("Not implemented");
    }
}

class UsersPageWatcher extends AccountWatcher {
    constructor(pageId, connection) {
        super(connection);
        this.pageId = pageId;
        this.walletStrToUserInfoWatcher = this.children;
        (async () => {
            const watchedKey = await consts.get_users_page_key(basePda, pageId);
            console.log(watchedKey.toString())
            this.init(watchedKey);
        })();
    }
    onUpdate(value) {
        if(value === null) {
            console.log("page="+this.pageId+" has not been allocated yet.");
            return;
        }
        console.log("Updated at page="+this.pageId);

        this.value = Parser.parseUsersPage(new Uint8Array(value.data));
        const walletStrList = this.value.map(k => k.toString()).filter(k=>k!=="11111111111111111111111111111111");
        const walletStrSet = new Set(walletStrList);
        console.log(walletStrSet);
        // if user no longer exists on page, remove it
        Object.keys(this.walletStrToUserInfoWatcher).map(walletStr=>{
            if(!walletStrSet.has(walletStr)) {
                this.removeUser(walletStr)
            }
        });
        // if user not found in previous cache, add it
        walletStrList.map( walletStr => {
            if(!this.walletStrToUserInfoWatcher.hasOwnProperty(walletStr)) {
                this.addUser(walletStr);
            }
        });
    }
    addUser(walletStr) {
        const walletKey = new PublicKey(walletStr);
        this.walletStrToUserInfoWatcher[walletStr] = new UserInfoWatcher(walletKey, this.connection);
    }
    removeUser(walletStr) {
        // FIXME: we had an exception thrown in here before when user gets deleted. Need to test and figure out why
        try {
            this.walletStrToUserInfoWatcher[walletStr].unsub();
            delete this.walletStrToUserInfoWatcher[walletStr];
        }
        catch(e) {
            console.error(e);
        }
    }
}

let poolIdToPrice = {};
const poolIdToPriceWatcher = {}

class UserInfoWatcher extends AccountWatcher {
    constructor(userWalletKey, connection) {
        super(connection);
        this.userWalletKey = userWalletKey;
        this.lastFiredTime = 0;
        this.availableForExternalLiquidation = false;
        (async () => {
            const watchedKey = await consts.get_user_info_key(userWalletKey);
            this.init(watchedKey);
        })();
    }
    onUpdate(value) {
        if(value===null)
            return;
        console.log("Updated at user="+this.userWalletKey.toString());
        this.value = Parser.parseUserInfo(new Uint8Array(value.data));
        console.log(this.value);
    }
    getTotalDepositAndBorrowInUsd() {
        const zero = 0;
        let [totalDepositUsd, totalBorrowUsd] = [zero, zero];
        for(var assetId in this.value.user_asset_info) {
            const uai = this.value.user_asset_info[assetId];
            const poolId = uai.pool_id;
            const price = poolIdToPriceWatcher[poolId].value.price_in_usd;
            totalDepositUsd += price * uai.deposit_amount / pool_id_to_decimal_multiplier[poolId];
            totalBorrowUsd += price * uai.borrow_amount / pool_id_to_decimal_multiplier[poolId];
        }
        return [totalDepositUsd, totalBorrowUsd];
    }
    getCollateralRatio() {
        /*
        returns null if user has no borrow/deposit
        otherwise returns collateral ratio
        */
       if(this.value === null) {
           return null;
       }
        let zero = (0);
        let [totalDepositUsd, totalBorrowUsd] = this.getTotalDepositAndBorrowInUsd();
        if (totalBorrowUsd === zero || totalDepositUsd === zero)
            return null;
        return totalDepositUsd * (100) / totalBorrowUsd;
    }
}


class PriceWatcher extends AccountWatcher {
    constructor(mintKey, connection) {
        super(connection);
        this.mintKey = mintKey;
        (async () => {
            const watchedKey = await consts.get_asset_price_key(pricePda, mintKey.toString());
            this.init(watchedKey);
        })();
    }
    onUpdate(value) {
        this.value = Parser.parseAssetPrice(new Uint8Array(value.data));
        console.log("Updated price for "+this.mintKey.toString());
        console.log(this.watchedKey.toString());
        console.log(this.value);
    }
}


/*
For the test run, we watch:
1. load all prices
2. start monitoring user pages and user infos
3. Every 10 seconds, look for accounts that can be liquidated
*/

// step 1
for(let poolId in poolList) {
    // skip deprecated pool
    poolId = parseInt(poolId);
    if(isDeprecated(poolId)) {
        poolIdToPriceWatcher[poolId] = null;
        continue;
    }
    poolIdToPriceWatcher[poolId] = new PriceWatcher(poolList[poolId], connection);
}

// keep waiting until we've loaded all price info
while (true) {
    let allFound = true;
    for(let poolId in poolList) {
        poolId = parseInt(poolId);
        // skip deprecated pool
        if(isDeprecated(poolId)){
            continue;
        }
        const watcher = poolIdToPriceWatcher[poolId];
        if (watcher.value === null) {
            allFound = false;
        }
    }
    if(allFound) {
        break;
    }
    else {
        await sleep(1000);
    }
}


// step 2
const pageIndexStart = 0;
const pageIndexEnd = 10;
const pageWatchers = [];

for(let i = pageIndexStart; i < pageIndexEnd; i++) {
    pageWatchers.push(new UsersPageWatcher(i, connection));
}


// step 3
while (true) {
    pageWatchers.map(pageWatcher=>{

        Object.values(pageWatcher.walletStrToUserInfoWatcher).map(uiw=>{
            const collateralRatio = uiw.getCollateralRatio();
            const walletStr = uiw.userWalletKey.toString();
            console.log(walletStr + ".collateral_ratio="+collateralRatio);
            // null means user has no borrow/deposit
            if(collateralRatio === null)
                return;
            if( collateralRatio < 110 ) {
                // add to external liquidation list
                console.log(walletStr + " reached collateral ratio " + collateralRatio + " and can be externally liquidated");
                // invoke extern_liquidate
                // TODO
                // wrapper.extern_liquidate(/**/);

                // WARNING: check out the FIXME in AccountWatcher. When we get notified of price updates and compute user's
                // collateral ratio, we might think that the user can already be liquidated. But the price we get at this time does
                // not seem to have been finalized. It takes about 20s for the price update to be finalized on-chain, so from the
                // time we realize a user can be liquidated, to the time it can actually be liquidated, there's about a 20s delay.
            }
        });
    });

    // sleep 10s. You may want to change this number to respond quickly
    await sleep(10000);
}
