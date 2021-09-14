import {
    consts, 
    ConnWrapper, 
    Parser, 
    pool_id_to_decimal_multiplier,
    poolIdToLtv,
    poolIdToMintStr,
} from "@apricot-lend/apricot"
import {Connection, PublicKey, Keypair} from "@solana/web3.js"
import {Token, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID} from '@solana/spl-token';
import {server, delay} from "./config.mjs";
import * as fs from "fs"

const testnetLiquidatorPrivateKey = [124,157,72,62,130,156,109,96,93,19,88,139,93,64,170,173,170,218,125,107,55,109,242,241,221,214,233,98,62,214,7,29,96,196,93,3,37,239,231,14,170,149,229,144,215,19,4,103,147,107,6,150,152,79,174,61,111,117,46,233,242,45,80,155];
const testnetLiquidatorAccount = Keypair.fromSecretKey(new Uint8Array(testnetLiquidatorPrivateKey));
const testnetLiquidatorPubkey = testnetLiquidatorAccount.publicKey;


const date = new Date();
const dateStr = date.toISOString();
const dateStrSub = dateStr.substr(0, dateStr.indexOf("."));
const updateLogger = fs.createWriteStream(`./assist.updates.${dateStrSub}`, {});
const updateTimedLogger = fs.createWriteStream(`./assist.updates.timed.${dateStrSub}`, {});
const actionTimedLogger = fs.createWriteStream(`./assist.actions.timed.${dateStrSub}`, {});

function logUpdate(str) {
    const time = new Date();
    updateLogger.write(str+'\n');
    updateTimedLogger.write(time.toISOString() + ": " + str+'\n');
    console.log(str);
}

function logAction(str) {
    const time = new Date();
    actionTimedLogger.write(time.toISOString() + ": " + str+'\n');
    console.log(str);
}

console.log(testnetLiquidatorPubkey);


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

let connection = new Connection(server, "confirmed");
let wrapper = new ConnWrapper(connection);

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
            // 4 TPS
            await sleep(delay);
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
            throttler.addNext(() => {
                this.subId = connection.onAccountChange(watchedKey, (value, ctx) => {
                    this.onUpdate(value);
                }, "confirmed");
            });

        });
    }
    unsub() {
        this.connection.removeAccountChangeListener(this.subId);
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
        logUpdate("Updated at page="+this.pageId);

        this.value = Parser.parseUsersPage(new Uint8Array(value.data));
        const walletStrList = this.value.map(k => k.toString()).filter(k=>k!=="11111111111111111111111111111111");
        const walletStrSet = new Set(walletStrList);
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
        this.value = Parser.parseUserInfo(new Uint8Array(value.data));
        logUpdate("Updated at user="+this.userWalletKey.toString()+", pageId="+this.value.page_id);
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
    }
}

class LiquidationPlanner {
    constructor(userInfo, userWalletKey) {
        this.value = userInfo;
        this.userWalletKey = userWalletKey;
        this.poolIdToDepositVal = {};
        this.poolIdToBorrowVal = {};
        this.totalBorrowVal = 0;
        this.totalBorrowLimitVal = 0;
        this.borrowLimitUsedPercent = null;
        this.computeStats();
    }
    computeStats() {
        const zero = 0;
        for(var assetId in this.value.user_asset_info) {
            const uai = this.value.user_asset_info[assetId];
            const poolId = uai.pool_id;
            const price = parseFloat(poolIdToPriceWatcher[poolId].value.price_in_usd);
            const addedDepositVal = price * parseFloat(uai.deposit_amount) / pool_id_to_decimal_multiplier[poolId];
            const addedBorrowVal = price * parseFloat(uai.borrow_amount) / pool_id_to_decimal_multiplier[poolId];
            this.poolIdToBorrowVal[poolId] = addedBorrowVal;
            this.poolIdToDepositVal[poolId] = addedDepositVal;
            this.totalBorrowLimitVal += addedDepositVal * poolIdToLtv[poolId];
            this.totalBorrowVal += addedBorrowVal;
        }
        if (this.totalBorrowVal === zero || this.totalBorrowLimitVal === zero) {
            this.borrowLimitUsedPercent = null;
        }
        else {
            this.borrowLimitUsedPercent = this.totalBorrowVal / this.totalBorrowLimitVal;
        }
    }
    getLiquidationSizes(collateralPoolIdVal, borrowedPoolIdVal) {
        const [collateralPoolId, collateralVal] = collateralPoolIdVal;
        const [borrowedPoolId, borrowedVal] = borrowedPoolIdVal;
        const postFactor = 0.9;
        const ltv = poolIdToLtv[collateralPoolId];
        // We need to sell/redeem X USD of asset and use it to repay our debt. To compute X:
        // (totalBorrow-X) / (borrowLimit - X*ltv) ~= postFactor
        // (totalBorrow-X)  ~= (borrowLimit - X*ltv) * postFactor
        // (1 - ltv * postFactor) * X ~= totalBorrow - borrowLimit * postFactor
        // X ~= (totalBorrow - borrowLimit * post_factor ) / (1 - ltv * post_factor)
        const X = (this.totalBorrowVal - this.totalBorrowLimitVal * postFactor) / (1 - postFactor * ltv);

        const liquidatableVal = Math.min(collateralVal, borrowedVal, X);
        const collateralPrice = parseFloat(poolIdToPriceWatcher[collateralPoolId].value.price_in_usd);
        const borrowedPrice = parseFloat(poolIdToPriceWatcher[borrowedPoolId].value.price_in_usd);
        
        const minCollateralAmt = liquidatableVal / collateralPrice * 0.999;
        const borrowedRepayAmt = liquidatableVal / borrowedPrice * 0.99;

        return [minCollateralAmt, borrowedRepayAmt];

    }
    pickLiquidationAction() {

        // pick most-valued collateral and most-valued borrowed asset
        const sortedCollateralVals = Object.entries(this.poolIdToDepositVal).sort((kv1,kv2)=>{
            return kv2[1] - kv1[1];
        });
        const sortedBorrowedVals = Object.entries(this.poolIdToBorrowVal).sort((kv1,kv2)=>{
            return kv2[1] - kv1[1];
        });
        const [collateralMinGetAmt, borrowedRepayAmt] = this.getLiquidationSizes(sortedCollateralVals[0], sortedBorrowedVals[0]);
        return [
            sortedCollateralVals[0][0], collateralMinGetAmt,
            sortedBorrowedVals[0][0], borrowedRepayAmt,
        ];
    }

    async fireLiquidationAction() {
        const [collateralPoolId, collateralAmt, borrowedPoolId, borrowedAmt] = this.pickLiquidationAction();
        const collateralMintStr = poolIdToMintStr[collateralPoolId];
        const collateralMintKey = new PublicKey(collateralMintStr);
        const borrowedMintStr = poolIdToMintStr[borrowedPoolId];
        const borrowedMintKey = new PublicKey(borrowedMintStr);
        logAction(collateralMintKey);
        logAction(borrowedMintKey);
        logAction(ASSOCIATED_TOKEN_PROGRAM_ID);
        logAction(TOKEN_PROGRAM_ID);
        logAction(testnetLiquidatorPubkey);
        const collateralSplKey = await Token.getAssociatedTokenAddress(ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, collateralMintKey, testnetLiquidatorPubkey);
        const borrowedSplKey = await Token.getAssociatedTokenAddress(ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, borrowedMintKey, testnetLiquidatorPubkey);
        logAction(collateralSplKey);
        logAction(borrowedSplKey);
        throttler.addNext(async () => {
            try{
                await wrapper.extern_liquidate(
                    testnetLiquidatorAccount,
                    this.userWalletKey,
                    collateralSplKey,
                    borrowedSplKey,
                    collateralMintStr,
                    borrowedMintStr,
                    collateralAmt * pool_id_to_decimal_multiplier[collateralPoolId],    // receive amount
                    borrowedAmt * pool_id_to_decimal_multiplier[borrowedPoolId],        // pay amount
                );
            }
            catch(e) {
                logAction(e);
            }
        });
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
    poolIdToPriceWatcher[poolId] = new PriceWatcher(poolList[poolId], connection);
}

// keep waiting until we've loaded all price info
while (true) {
    let allFound = true;
    for(let poolId in poolList) {
        poolId = parseInt(poolId);
        // skip deprecated pool
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
const [_node, _script, pageStart, pageEnd] = process.argv;
const pageIndexStart = parseInt(pageStart);
const pageIndexEnd = parseInt(pageEnd);
const pageWatchers = [];

for(let i = pageIndexStart; i < pageIndexEnd; i++) {
    pageWatchers.push(new UsersPageWatcher(i, connection));
}


// step 3
while (true) {
    console.log("=================="+new Date());
    for(let pageWatcher of pageWatchers) {
        let uiws = Object.values(pageWatcher.walletStrToUserInfoWatcher);
        let received = 0;
        for(let uiw of uiws) {
            if(uiw.value === null) {
                continue;
            }
            received += 1;
            const planner = new LiquidationPlanner(uiw.value, uiw.userWalletKey);
            const walletStr = uiw.userWalletKey.toString();
            if(planner.borrowLimitUsedPercent > 0.97) {
                console.log(walletStr + ".borrowLimUsed="+planner.borrowLimitUsedPercent+", pageId="+pageWatcher.pageId);
            }
            // null means user has no borrow/deposit
            if(planner.borrowLimitUsedPercent === null){
                continue;
            }
            if( planner.borrowLimitUsedPercent > 1.0 ) {
                // add to external liquidation list
                console.log(walletStr + " reached borrowLimUsed=" + planner.borrowLimitUsedPercent + " and can be externally liquidated");
                // invoke extern_liquidate
                // TODO
                // wrapper.extern_liquidate(/**/);

                // WARNING: check out the FIXME in AccountWatcher. When we get notified of price updates and compute user's
                // collateral ratio, we might think that the user can already be liquidated. But the price we get at this time does
                // not seem to have been finalized. It takes about 20s for the price update to be finalized on-chain, so from the
                // time we realize a user can be liquidated, to the time it can actually be liquidated, there's about a 20s delay.
                let nowTime = new Date().getTime();

                // if throttler has loads of requests pending, lay low first
                if(throttler.tasks.length < 100) {
                    // for each user, we fire at most once every 20 seconds
                    if((nowTime - uiw.lastFiredTime) > 20 * 1000) {
                        planner.fireLiquidationAction();
                        uiw.lastFiredTime = nowTime;
                    }
                }
            }
        }
        console.log(`${pageWatcher.pageId}, ${received}/${uiws.length}`);
    }

    // sleep 10s. You may want to change this number to respond quickly
    await sleep(10000);
}
