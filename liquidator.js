/*global BigInt */
const {consts, ConnWrapper, Parser} = require("@apricot-lend/apricot");
const {Connection, PublicKey, Account} =  require("@solana/web3.js");
// import {Token, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID} from '@solana/spl-token';

/*
constantly monitor:
- UserPagesStats: addPage/removePage
- each UsersPage: addUser/removeUser
- each UserInfo: monitor collateral ratio


Note to liquidators: search for TODO (around line 160). That's where you plug in the call to

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
const sleep = function(duration) {
    return new Promise((resolve) => {
        setTimeout(() => {
            resolve();
        }, duration);
    });
};
Parser.parseUsersPage = (data) => {
    let result = [];
    let count = data.length / 32;
    for(let i = 0; i < count; i++) {
        const offset = i * 32;
        const end = offset + 32;
        result[i] = new PublicKey(new Uint8Array(data.slice(offset, end)));
    }
    return result;
}

(async () => {

let connection = new Connection("https://api.devnet.solana.com", "finalized");
// let wrapper = new ConnWrapper(connection);

console.log(await connection.getRecentBlockhash());
console.log("connected");

const [basePda, _] = await consts.get_base_pda();
const [pricePda, __] = await consts.get_price_pda();

let poolListKey = await consts.get_pool_list_key(basePda);
let poolList = Parser.parsePoolList((await connection.getParsedAccountInfo(poolListKey)).value.data);

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
            console.log(`User page ${pageId} watch key: ${watchedKey.toString()}`);
            this.init(watchedKey);
        })();
    }
    onUpdate(value) {
        console.log("Updated at page="+this.pageId);
        if (!value) {
            console.log(`Value is empty: ${value}`);
            return;
        }
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
        console.log(`Parsed user info: `, this.value);
        // compute collateral ratio
        const collateralRatio = this.getCollateralRatio(poolIdToPrice);
        const walletStr = this.userWalletKey.toString();
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
        }
    }
    getTotalDepositAndBorrowInUsd(poolIdToPrice) {
        const zero = 0;
        let [totalDepositUsd, totalBorrowUsd] = [zero, zero];
        for(let uai of this.value.user_asset_info) {
            const poolId = uai.pool_id;
            const price = poolIdToPrice[poolId].price_in_usd;
            console.log(`Pool id ${poolId} price in usd: ${price}`);
            totalDepositUsd += price * uai.deposit_amount / 10000000;
            totalBorrowUsd += price * uai.borrow_amount / 10000000;
        }
        return [totalDepositUsd, totalBorrowUsd];
    }
    getCollateralRatio(poolIdToPrice) {
        /*
        returns null if user has no borrow/deposit
        otherwise returns collateral ratio
        */
       if(this.value === null) {
           return null;
       }
        let zero = 0;
        let [totalDepositUsd, totalBorrowUsd] = this.getTotalDepositAndBorrowInUsd(poolIdToPrice);
        if (totalBorrowUsd === zero || totalDepositUsd === zero)
            return null;
        return totalDepositUsd * 100 / totalBorrowUsd;
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
*/

// step 1
const poolIdToPriceWatcher = {}
for(let poolId in poolList) {
    poolIdToPriceWatcher[poolId] = new PriceWatcher(poolList[poolId], connection);
}

// wait until we've loaded all price info
while (true) {
    let allFound = true;
    for(let poolId in poolList) {
        const watcher = poolIdToPriceWatcher[poolId];
        if (watcher.value === null) {
            allFound = false;
            await sleep(1000);
        }
        else {
            poolIdToPrice[poolId] = watcher.value;
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
const pageIndexEnd = 100;
const pageWatchers = [];

for(let i = pageIndexStart; i < pageIndexEnd; i++) {
    pageWatchers.push(new UsersPageWatcher(i, connection));
}


// keep running, and maybe print status
while (true) {
    await sleep(10000);
}
})();
