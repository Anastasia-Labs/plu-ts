import { fromHex, fromUtf8, isUint8Array, lexCompare, toHex } from "@harmoniclabs/uint8array-utils";
import { keepRelevant } from "./keepRelevant";
import { GenesisInfos, NormalizedGenesisInfos, defaultMainnetGenesisInfos, defaultPreprodGenesisInfos, isGenesisInfos, isNormalizedGenesisInfos, normalizedGenesisInfos } from "./GenesisInfos";
import { isCostModelsV2, isCostModelsV1, defaultV2Costs, defaultV1Costs, costModelsToLanguageViewCbor, isCostModelsV3, defaultV3Costs } from "@harmoniclabs/cardano-costmodels-ts";
import { NetworkT, ProtocolParameters, isPartialProtocolParameters, Tx, Value, ValueUnits, TxOut, TxRedeemerTag, txRdmrTagToString, ScriptType, UTxO, VKeyWitness, Script, BootstrapWitness, TxRedeemer, Hash32, TxIn, Hash28, AuxiliaryData, TxWitnessSet, getNSignersNeeded, txRedeemerTagToString, ScriptDataHash, Address, AddressStr, TxBody, CredentialType, canBeHash32, VotingProcedures, ProposalProcedure } from "@harmoniclabs/cardano-ledger-ts";
import { CborString, CborPositiveRational, Cbor, CborArray, CanBeCborString } from "@harmoniclabs/cbor";
import { byte, blake2b_256 } from "@harmoniclabs/crypto";
import { Data, dataToCborObj, DataConstr, dataToCbor } from "@harmoniclabs/plutus-data";
import { Machine, ExBudget } from "@harmoniclabs/plutus-machine";
import { UPLCTerm, UPLCDecoder, Application, UPLCConst, ErrorUPLC } from "@harmoniclabs/uplc";
import { POSIXToSlot, getTxInfos, slotToPOSIX } from "../toOnChain";
import { ITxBuildArgs, ITxBuildOptions, ITxBuildInput, ITxBuildSyncOptions, txBuildOutToTxOut, normalizeITxBuildArgs, NormalizedITxBuildInput } from "../txBuild";
import { CanBeUInteger, forceBigUInt, canBeUInteger, unsafeForceUInt } from "../utils/ints";
import { freezeAll, defineReadOnlyProperty, definePropertyIfNotPresent, hasOwn, isObject } from "@harmoniclabs/obj-utils";
import { assert } from "../utils/assert";
import { TxBuilderRunner } from "./TxBuilderRunner/TxBuilderRunner";
import { ITxRunnerProvider } from "./IProvider";
import { CanBeData, canBeData, forceData } from "../utils/CanBeData";
import { getSpendingPurposeData } from "../toOnChain/getSpendingPurposeData";
import { TxBuilderProtocolParams, ValidatedTxBuilderProtocolParams, completeTxBuilderProtocolParams } from "./TxBuilderProtocolParams";
import { ChangeInfos } from "../txBuild/ChangeInfos/ChangeInfos";
import { scriptTypeToDataVersion } from "./utils";

type ScriptLike = {
    hash: string,
    bytes: Uint8Array
}

const scriptCache: { [x: string]: UPLCTerm } = {};

function getScriptLikeUplc( scriptLike: ScriptLike ): UPLCTerm
{
    let script: UPLCTerm;
    if(
        (script = scriptCache[scriptLike.hash]) === undefined
    )
    {
        script = UPLCDecoder.parse(
            scriptLike.bytes,
            "flat"
        ).body;
        Object.defineProperty(
            scriptCache, scriptLike.hash, {
                value: script,
                writable: false,
                enumerable: true,
                configurable: false
            }
        )
    }

    return script;
}

export class TxBuilder
{
    readonly protocolParamters!: ValidatedTxBuilderProtocolParams
    readonly genesisInfos?: NormalizedGenesisInfos

    setGenesisInfos!: ( geneisInfos: GenesisInfos ) => void;

    runWithProvider( provider: Partial<ITxRunnerProvider> ): TxBuilderRunner
    {
        return new TxBuilderRunner( this, provider );
    }
    
    constructor(
        protocolParamters?: Readonly<TxBuilderProtocolParams>,
        genesisInfos?: GenesisInfos
    )
    {
        let _genesisInfos: NormalizedGenesisInfos | undefined = undefined;
        const _setGenesisInfos = ( genInfos: GenesisInfos ): void => {
            if( !isGenesisInfos( genInfos ) ) return;

            _genesisInfos = freezeAll( normalizedGenesisInfos( genInfos ) );
        }
        _setGenesisInfos( genesisInfos! );
        Object.defineProperties(
            this,
            {
                genesisInfos: {
                    get: () => _genesisInfos,
                    set: _setGenesisInfos,
                    enumerable: true,
                    configurable: false
                },
                setGenesisInfos: {
                    value: _setGenesisInfos,
                    writable: false,
                    enumerable: true,
                    configurable: false
                }
            }
        );

        const pp = completeTxBuilderProtocolParams( protocolParamters );
        
        defineReadOnlyProperty(
            this,
            "protocolParamters",
            freezeAll( protocolParamters )
        );

        const costmdls = pp.costModels;
        const costs = isCostModelsV3( costmdls.PlutusScriptV3 ) ? costmdls.PlutusScriptV3 :
            isCostModelsV2( costmdls.PlutusScriptV2 ) ? costmdls.PlutusScriptV2 :
            isCostModelsV1( costmdls.PlutusScriptV1 ) ? costmdls.PlutusScriptV1 :
            defaultV3Costs;

        definePropertyIfNotPresent(
            this,
            "cek",
            {
                // define as getter so that it can be reused without messing around things
                get: () => new Machine({ ...costs }),
                // set does nothing ( aka. readonly )
                set: () => {},
                enumerable: false,
                configurable: false
            }
        );
    }

    keepRelevant(
        requestedOutputSet: Value | ValueUnits,
        initialUTxOSet: ITxBuildInput[],
        minimumLovelaceRequired: CanBeUInteger = 5_000_000,
    ): ITxBuildInput[]
    {
        return keepRelevant(
            requestedOutputSet,
            initialUTxOSet,
            minimumLovelaceRequired
        );
    }

    calcLinearFee( tx: Tx | CborString ): bigint
    {
        return (
            forceBigUInt( this.protocolParamters.txFeePerByte ) *
            BigInt( (tx instanceof Tx ? tx.toCbor() : tx ).toBuffer().length ) +
            forceBigUInt( this.protocolParamters.txFeeFixed )
        );
    }

    getMinimumOutputLovelaces( tx_out: TxOut | CanBeCborString ): bigint
    {
        let size = BigInt( 0 );
        if( tx_out instanceof TxOut ) tx_out = tx_out.toCbor().toBuffer();
        
        if( typeof tx_out === "string" ) size = BigInt( Math.ceil( tx_out.length / 2 ) );
        else if(!(tx_out instanceof Uint8Array))
        {
            if(
                isObject( tx_out ) &&
                hasOwn( tx_out, "toBuffer" ) && 
                typeof tx_out.toBuffer === "function"
            )
            tx_out = tx_out.toBuffer();

            if(!(tx_out instanceof Uint8Array)) tx_out = fromHex( tx_out.toString() );
        }

        if( tx_out instanceof Uint8Array ) size = BigInt( tx_out.length );
        
        return BigInt( this.protocolParamters.utxoCostPerByte ) * size;
    }

    /**
     * 
     * @param slotN number of the slot
     * @returns POSIX time in **milliseconds**
     */
    slotToPOSIX( slot: CanBeUInteger, genesisInfos?: GenesisInfos ): number
    {
        const gInfos = genesisInfos ? normalizedGenesisInfos( genesisInfos ) : this.genesisInfos;
        if( gInfos === undefined )
        {
            throw new Error("can't convert slot to POSIX time because genesis infos are missing");
        }

        return slotToPOSIX(
            unsafeForceUInt( slot ),
            gInfos
        );
    }

    /**
     * 
     * @param POSIX POSIX time in milliseconds
     */
    posixToSlot( POSIX: CanBeUInteger, genesisInfos?: GenesisInfos  ): number
    {
        const gInfos = genesisInfos ? normalizedGenesisInfos( genesisInfos ) : this.genesisInfos;
        if( gInfos === undefined )
        {
            throw new Error("can't convert POSIX to slot time because genesis infos are missing");
        }

        return POSIXToSlot(
            unsafeForceUInt( POSIX ),
            gInfos
        );
    }

    /**
     * here mainly for forward compability
     * 
     * internally calls `buildSync` so really what `build` is doing is wrapping it in a `Promise`
     * 
     * In future this method might implement multi-threading using `Worker`s
     */
    async build(
        buildArgs: ITxBuildArgs,
        buildOpts: ITxBuildOptions = {}
    ): Promise<Tx>
    {
        return this.buildSync( buildArgs, buildOpts );
    }

    /**
     * replaces the redeemers and clears vkeyWitnesses in the witness set
     * and re-computes the `scriptDataHash` in the body
     * 
     * the input transaction is readonly and is not modified
     * 
     * **A NEW TRANSACTION IS CREATED** with vkey witness set empty
     * (the new transaction is unsigned)
     * 
     * to summarize, the new transaction differs in:
     * 1) `tx.body.scriptDataHash`
     * 2) `tx.witnesses.redeemers`
     * 3) `tx.witnesses.vkeyWitnesses` (empty)
     */
    overrideTxRedeemers( tx: Tx, newRedeemers: TxRedeemer[] ): Tx
    {
        // datums passed by hash
        const datums = tx.witnesses.datums ?? [];
        return new Tx({
            ...tx,
            body: new TxBody({
                ...tx.body,
                scriptDataHash: getScriptDataHash(
                    newRedeemers,
                    datums.length > 0 ?
                        Array.from(
                            Cbor.encode(
                                new CborArray(
                                    datums.map( dataToCborObj )
                                )
                            ).toBuffer()
                        ) 
                    : [],
                    costModelsToLanguageViewCbor(
                        this.protocolParamters.costModels,
                        { mustHaveV2: true, mustHaveV1: false }
                    ).toBuffer()
                )
            }),
            witnesses: new TxWitnessSet({
                ...tx.witnesses,
                vkeyWitnesses: [],
                redeemers: newRedeemers
            })
        });
    }

    buildSync(
        buildArgs: ITxBuildArgs,
        {
            onScriptInvalid,
            onScriptResult
        }: ITxBuildSyncOptions = {}
    ): Tx
    {
        const _initBuild = this.initTxBuild( buildArgs );

        const {
            // tx,
            scriptsToExec,
            minFee,
            datumsScriptData,
            languageViews,
            totInputValue,
            requiredOutputValue,
            outs,
            change
        } = _initBuild;

        let tx = _initBuild.tx;

        const rdmrs = tx.witnesses.redeemers ?? [];
        const nRdmrs = rdmrs.length;

        if( nRdmrs === 0 ){
            this.assertMinOutLovelaces( tx.body.outputs );
            return tx
        };

        const txOuts: TxOut[] = new Array( outs.length + 1 );

        const cek: Machine = (this as any).cek;
        
        if( !(cek instanceof Machine) )
        throw new Error(
            "unable to construct transaction including scripts " +
            "if the protocol params are missing the script evaluation costs"
        )

        const executionUnitPrices = this.protocolParamters.executionUnitPrices;
        const [ memRational, cpuRational ] = executionUnitPrices;

        // group by purpose so we can use the redeemer index to find the script
        const spendScriptsToExec =      scriptsToExec.filter( elem => elem.rdmrTag === TxRedeemerTag.Spend );
        const mintScriptsToExec =       scriptsToExec.filter( elem => elem.rdmrTag === TxRedeemerTag.Mint );
        const certScriptsToExec =       scriptsToExec.filter( elem => elem.rdmrTag === TxRedeemerTag.Cert );
        const withdrawScriptsToExec =   scriptsToExec.filter( elem => elem.rdmrTag === TxRedeemerTag.Withdraw );
        const voteScriptsToExec =       scriptsToExec.filter( elem => elem.rdmrTag === TxRedeemerTag.Voting );
        const proposeScriptsToExec =    scriptsToExec.filter( elem => elem.rdmrTag === TxRedeemerTag.Proposing );

        const maxRound = 3;

        let _isScriptValid: boolean = true;
        let fee = minFee;
        let prevFee: bigint;

        for( let round = 0; round < maxRound; round++ )
        {
            prevFee = fee;

            const { v1: txInfosV1, v2: txInfosV2, v3: txInfosV3 } = getTxInfos( tx, this.genesisInfos );

            let totExBudget = new ExBudget({ mem: 0, cpu: 0 });

            for( let i = 0 ; i < nRdmrs; i++)
            {
                const rdmr = rdmrs[i];
                const { tag, data: rdmrData, index: rdmr_idx } = rdmr;
                // "+ 1" because we keep track of lovelaces even if in mint values these are 0
                const index = rdmr_idx + (tag === TxRedeemerTag.Mint ? 1 : 0);
                // const spendingPurpose = getSpendingPurposeData( rdmr, tx.body );

                const onlyRedeemerArg = ( purposeScriptsToExec: ScriptToExecEntry[] ) =>
                {
                    const script = purposeScriptsToExec.find( ({ index: idx }) => idx === index )?.script;

                    if( script === undefined )
                    throw new Error(
                        "missing script for " + txRedeemerTagToString(tag) + " redeemer " + (index - 1)
                    );

                    const expectedVersion = scriptTypeToDataVersion( script.type );

                    if( typeof expectedVersion !== "string" )
                    throw new Error("unexpected redeemer for native script");

                    const ctxData = getCtx(
                        script.type,
                        getSpendingPurposeData( rdmr, tx.body, expectedVersion ),
                        txInfosV1,
                        txInfosV2,
                        txInfosV3,
                    );

                    const { result, budgetSpent, logs } = cek.eval(
                        new Application(
                            new Application(
                                getScriptLikeUplc( script ),
                                UPLCConst.data( rdmrData )
                            ),
                            UPLCConst.data(
                                ctxData
                            )
                        )
                    );

                    _isScriptValid = onEvaluationResult(
                        i,
                        totExBudget,
                        rdmr,
                        result,
                        budgetSpent,
                        logs,
                        [
                            rdmrData,
                            ctxData
                        ],
                        rdmrs,
                        onScriptResult,
                        onScriptInvalid
                    );
                }

                if( tag === TxRedeemerTag.Spend )
                {
                    const entry = spendScriptsToExec.find( ({ index: idx }) => idx === index );

                    if( entry === undefined )
                    throw new Error(
                        "missing script for spend redeemer " + index
                    );

                    const { script, datum } = entry;

                    if( datum === undefined )
                    throw new Error(
                        "missing datum for spend redeemer " + index
                    );

                    const expectedVersion = scriptTypeToDataVersion( script.type );

                    if( typeof expectedVersion !== "string" )
                    throw new Error("unexpected redeemer for native script");

                    const ctxData = getCtx(
                        script.type,
                        getSpendingPurposeData( rdmr, tx.body, expectedVersion ),
                        txInfosV1,
                        txInfosV2,
                        txInfosV3
                    );

                    const { result, budgetSpent, logs } = cek.eval(
                        new Application(
                            new Application(
                                new Application(
                                    getScriptLikeUplc( script ),
                                    UPLCConst.data( datum )
                                ),
                                UPLCConst.data( rdmrData )
                            ),
                            UPLCConst.data(
                                ctxData
                            )
                        )
                    );

                    _isScriptValid = onEvaluationResult(
                        i,
                        totExBudget,
                        rdmr,
                        result,
                        budgetSpent,
                        logs,
                        [
                            datum,
                            rdmrData,
                            ctxData
                        ],
                        rdmrs,
                        onScriptResult,
                        onScriptInvalid
                    );
                }
                else if( tag === TxRedeemerTag.Mint )       onlyRedeemerArg( mintScriptsToExec )
                else if( tag === TxRedeemerTag.Cert )       onlyRedeemerArg( certScriptsToExec )
                else if( tag === TxRedeemerTag.Withdraw )   onlyRedeemerArg( withdrawScriptsToExec )
                else if( tag === TxRedeemerTag.Voting )     onlyRedeemerArg( voteScriptsToExec )
                else if( tag === TxRedeemerTag.Proposing )  onlyRedeemerArg( proposeScriptsToExec )
                else throw new Error(
                    "unrecoignized redeemer tag " + tag
                )
            }

            fee = minFee +
                ((totExBudget.mem * memRational.num) / memRational.den) +
                ((totExBudget.cpu * cpuRational.num) / cpuRational.den) +
                // bigint division truncates always towards 0;
                // we don't like that so we add `1n` for both divisions ( + 2n )
                BigInt(2);

            if( fee === prevFee ) break; // return last transaciton

            // reset for next loop
            
            // no need to reset if there's no next loop
            if( round === maxRound - 1 ) break;

            outs.forEach( (txO, i) => txOuts[i] = txO.clone() );
            txOuts[ txOuts.length - 1 ] = (
                new TxOut({
                    address: change.address,
                    value: Value.sub(
                        totInputValue,
                        Value.add(
                            requiredOutputValue,
                            Value.lovelaces( fee )
                        )
                    ),
                    datum: change.datum ? (
                        canBeHash32( change.datum ) ?
                        new Hash32( change.datum ) :
                        forceData( change.datum )
                    ): undefined,
                    refScript: change.refScript
                })
            );

            tx = new Tx({
                ...tx,
                body: new TxBody({
                    ...tx.body,
                    outputs: txOuts,
                    fee: fee,
                    scriptDataHash: getScriptDataHash( rdmrs, datumsScriptData, languageViews )
                }),
                witnesses: new TxWitnessSet({
                    ...tx.witnesses,
                    redeemers: rdmrs,
                }),
                isScriptValid: _isScriptValid
            });

            _isScriptValid = true;
            totExBudget = new ExBudget({ mem: 0, cpu: 0 })
        }

        this.assertMinOutLovelaces( tx.body.outputs );

        return tx;
    }

    assertMinOutLovelaces( txOuts: TxOut[] ): void
    {
        for(let i = 0; i < txOuts.length; i++)
        {
            const out = txOuts[i];
            const minLovelaces = this.getMinimumOutputLovelaces( out );

            if( out.value.lovelaces < minLovelaces )
            throw new Error(
                `tx output at index ${i} did not have enough lovelaces to meet the minimum allowed by protocol parameters.\n` +
                `output size: ${out.toCbor().toBuffer().length} bytes\n` +
                `protocol paramters "utxoCostPerByte": ${this.protocolParamters.utxoCostPerByte}\n` +
                `minimum lovelaces required: ${minLovelaces.toString()}\n` +
                `output lovelaces          : ${out.value.lovelaces.toString()}\n` +
                `tx output: ${JSON.stringify( out.toJson(), undefined, 2 )}`
            );
        }
    }

    /**
     * extracts the important data from the input
     * and returns it in an easier way to opearte with
     * 
     * if the transaction is simple enough (aka. it doesn't include plutus scripts)
     * this is all that either `build` or `buildSync` needs to do
    **/
    protected initTxBuild(
        buildArgs: ITxBuildArgs
    ) : {
        tx: Tx,
        scriptsToExec: ScriptToExecEntry[],
        minFee: bigint,
        datumsScriptData: number[],
        languageViews: Uint8Array,
        totInputValue: Value,
        requiredOutputValue: Value,
        outs: TxOut[],
        change: ChangeInfos
    }
    {
        const {
            outputs,
            requiredSigners,
            collaterals,
            collateralReturn,
            mints,
            invalidAfter,
            certificates,
            withdrawals,
            metadata,
            votingProcedures,
            proposalProcedures,
            currentTreasuryValue,
            paymentToTreasury,
            ...args
        } = normalizeITxBuildArgs( buildArgs );

        // mutable args
        let {
            inputs,
            changeAddress,
            change,
            invalidBefore,
            readonlyRefInputs
        } = args;

        if( change ) changeAddress = change.address;

        if( !changeAddress )
        throw new Error(
            "missing changAddress and change entry while constructing a transaciton; unable to balance inputs and outpus"
        );

        if( !change ) change = { address: changeAddress };

        const network = changeAddress.network;
        if( !isNormalizedGenesisInfos( this.genesisInfos ) )
        {
            this.setGenesisInfos(
                network === "mainnet" ?
                    defaultMainnetGenesisInfos :
                    defaultPreprodGenesisInfos
            );
        }

        const undef: undefined = void 0;

        // filter inputs so that are unique
        inputs = inputs.reduce((accum, input) => {
            const samePresent = accum.some(({ utxo: accumUtxo }) => eqUTxOByRef( accumUtxo, input.utxo ) );
            if( !samePresent ) accum.push( input )
            return accum;
        }, [] as NormalizedITxBuildInput[]);

        // filter refIns so that are unique
        readonlyRefInputs = readonlyRefInputs?.reduce(( accum, utxo ) => {
            const samePresent = accum.some(( accumUtxo ) => eqUTxOByRef( accumUtxo, utxo ) );
            if( !samePresent ) accum.push( utxo )
            return accum;
        }, [] as UTxO[])

        let totInputValue = Value.zero;
        const refIns: UTxO[] = readonlyRefInputs ?? [];

        const outs = outputs ?? [];
        const requiredOutputValue = outs.reduce((acc, out) => Value.add( acc, out.value ), Value.zero );

        const vkeyWitnesses: VKeyWitness[] = [];
        const nativeScriptsWitnesses: Script<ScriptType.NativeScript>[] = [];
        const bootstrapWitnesses: BootstrapWitness[] = [];
        const plutusV1ScriptsWitnesses: Script<ScriptType.PlutusV1>[] = [];
        const datums: Data[] = []
        const plutusV2ScriptsWitnesses: Script<ScriptType.PlutusV2>[] = [];
        const plutusV3ScriptsWitnesses: Script<ScriptType.PlutusV3>[] = [];
        
        const dummyExecBudget = ExBudget.maxCborSize;

        const spendRedeemers: TxRedeemer[] = [];
        const mintRedeemers: TxRedeemer[] = [];
        const certRedeemers: TxRedeemer[] = [];
        const withdrawRedeemers: TxRedeemer[] = [];
        const voteRedeemers: TxRedeemer[] = [];
        const proposeRedeemers: TxRedeemer[] = [];

        const scriptsToExec: ScriptToExecEntry[] = [];
        
        /**
         * needed in `getScriptDataHash` to understand whoich cost model to transform in language view
         */
        let _hasV1Scripts = false;
        /**
         * needed in `getScriptDataHash` to understand whoich cost model to transform in language view
         */
        let _hasV2Scripts = false;
        /**
         * needed in `getScriptDataHash` to understand whoich cost model to transform in language view
         */
        let _hasV3Scripts = false;

        function pushScriptToExec( idx: number, tag: TxRedeemerTag, script: Script, datum?: Data )
        {
            if( script.type == ScriptType.NativeScript ) return;

            // keep track of exsisting csript versions
            if( !_hasV1Scripts && script.type === "PlutusScriptV1" )
            {
                _hasV1Scripts = true;
            }
            else if( !_hasV2Scripts && script.type === "PlutusScriptV2" )
            {
                _hasV2Scripts = true;
            }
            else if( !_hasV3Scripts && script.type === "PlutusScriptV3" )
            {
                _hasV3Scripts = true;
            }

            scriptsToExec.push({
                index: idx,
                rdmrTag: tag,
                script: {
                    type: script.type as any,
                    bytes: script.bytes,
                    hash: script.hash.toString()
                },
                datum
            });
        }
        function pushWitScript( script : Script ): void
        {
            const t = script.type;
            
            if( t === "NativeScript"  )         pushUniqueScript( nativeScriptsWitnesses  , script as any );
            else if( t === "PlutusScriptV1" )   pushUniqueScript( plutusV1ScriptsWitnesses, script as any );
            else if( t === "PlutusScriptV2" )   pushUniqueScript( plutusV2ScriptsWitnesses, script as any );
            else if( t === "PlutusScriptV3" )   pushUniqueScript( plutusV3ScriptsWitnesses, script as any );
        }

        /**
         * @returns `Script` to execute
         */
        function checkScriptAndPushIfInline( script: { inline: Script } | { ref: UTxO } ): Script
        {
            if( hasOwn( script, "inline" ) )
            {
                if( hasOwn( script, "ref" ) )
                throw new Error(
                    "multiple scripts specified"
                );

                pushWitScript( script.inline );

                return script.inline;
            }
            if( hasOwn( script, "ref" ) )
            {
                if( hasOwn( script, "inline" ) )
                throw new Error(
                    "multiple scripts specified"
                );

                const refScript = (script.ref as UTxO)?.resolved?.refScript;

                if( refScript === (void 0) )
                throw new Error(
                    "script was specified to be a reference script " +
                    "but the provided utxo is missing any attached script"
                );

                if( !refIns.some( u => eqUTxOByRef( u, script.ref )) )
                {
                    refIns.push( script.ref );
                } 
                return refScript;
            }

            throw new Error("unexpected execution flow 'checkScriptAndPushIfInline' in TxBuilder");
        }

        /**
         * 
         * @param datum 
         * @param inlineDatum 
         * @returns the `Data` of the datum
         */
        function pushWitDatum(
            datum: CanBeData | "inline",
            inlineDatum: CanBeData | Hash32 | undefined
        ): Data
        {
            if( datum === "inline" )
            {
                if( !canBeData( inlineDatum ) )
                throw new Error(
                    "datum was specified to be inline; but inline datum is missing"
                );

                // no need to push to witnesses

                return forceData( inlineDatum );
            }
            else
            {
                const dat = forceData( datum );

                // add datum to witnesses
                // the node finds it trough the datum hash (on the utxo)
                datums.push( dat );

                return dat;
            }
        }

        let isScriptValid: boolean = true;

        // `sort` mutates the array; so we `slice` (clone) first
        const sortedIns = inputs.slice().sort((a,b) => {
            const ord = lexCompare( a.utxo.utxoRef.id.toBuffer(), b.utxo.utxoRef.id.toBuffer() );
            // if equal tx id order based on tx output index
            if( ord === 0 ) return a.utxo.utxoRef.index - b.utxo.utxoRef.index;
            // else order by tx id
            return ord;
        });

        const _inputs = inputs.map( (input) =>
        {
            const {
                utxo,
                referenceScript,
                inputScript
            } = input;

            const addr = utxo.resolved.address;

            totInputValue =  Value.add( totInputValue, utxo.resolved.value );

            if(
                addr.paymentCreds.type === CredentialType.Script &&
                referenceScript === undef &&
                inputScript === undef
            )
            throw new Error(
                "spending script utxo \"" + utxo.utxoRef.toString() + "\" without script source"
            );

            if( referenceScript !== undef )
            {
                if( inputScript !== undef )
                throw new Error(
                    "invalid input; multiple scripts specified"
                );

                const {
                    datum,
                    redeemer,
                    refUtxo
                } = referenceScript;

                const refScript = refUtxo.resolved.refScript;

                if( refScript === undefined )
                throw new Error(
                    "reference utxo specified (" + refUtxo.toString() + ") is missing an attached reference Script"
                )

                const sameRefPresent = refIns.find( u => eqUTxOByRef( u, refUtxo ) )
                if( sameRefPresent === undef )
                {
                    refIns.push( refUtxo );
                }

                const dat = pushWitDatum( datum, utxo.resolved.datum );

                const i = sortedIns.indexOf( input );
                if( i < 0 ) throw new Error("input missing in sorted");

                spendRedeemers.push(new TxRedeemer({
                    data: forceData( redeemer ),
                    index: i,
                    execUnits: dummyExecBudget.clone(),
                    tag: TxRedeemerTag.Spend
                }));

                pushScriptToExec( i, TxRedeemerTag.Spend, refScript, dat );
            }
            if( inputScript !== undefined )
            {
                if( referenceScript !== undefined )
                throw new Error(
                    "invalid input; multiple scripts specified"
                );

                const {
                    datum,
                    redeemer,
                    script
                } = inputScript;

                pushWitScript( script );

                const dat = pushWitDatum( datum, utxo.resolved.datum ); 

                const i = sortedIns.indexOf( input );
                if( i < 0 ) throw new Error("input missing in sorted");

                spendRedeemers.push(new TxRedeemer({
                    data: forceData( redeemer ),
                    index: i,
                    execUnits: dummyExecBudget.clone(),
                    tag: TxRedeemerTag.Spend
                }));
                
                pushScriptToExec( i, TxRedeemerTag.Spend, script, dat );
            }

            return new TxIn( utxo )
        }) as [TxIn, ...TxIn[]];
        
        // good luck spending more than 4294.967295 ADA in fees
        // also 16.777215 ADA (3 bytes) is a lot; but CBOR only uses 2 or 4 bytes integers
        // and 2 are ~0.06 ADA (too low) so go for 4;
        const dummyFee = BigInt( "0xffffffff" );

        const dummyOuts = outs.map( txO => txO.clone() )

        // add dummy change address output
        dummyOuts.push(
            new TxOut({
                address: change.address,
                value: Value.sub(
                    totInputValue,
                    Value.add(
                        requiredOutputValue,
                        Value.lovelaces(
                            forceBigUInt(
                                this.protocolParamters.txFeePerByte 
                            )
                        )
                    )
                ),
                datum: change.datum ? (
                    change.datum instanceof Hash32 ?
                    change.datum :
                    forceData( change.datum )
                ): undef,
                refScript: change.refScript
            })
        );

        // index to be modified
        const dummyMintRedeemers: [ Hash32, Script, TxRedeemer ][] = [];

        const _mint: Value | undefined = mints?.reduce( (accum, {
                script,
                value
            }, i ) => {

                const redeemer = script.redeemer;
                const policyId = value.policy;

                const toExec = checkScriptAndPushIfInline( script );

                dummyMintRedeemers.push([
                    policyId,
                    toExec,
                    new TxRedeemer({
                        data: forceData( redeemer ),
                        index: i, // to be modified as `indexOfPolicy( policyId )`
                        execUnits: dummyExecBudget.clone(),
                        tag: TxRedeemerTag.Mint
                    })
                ]);

                return Value.add( accum, new Value([ value ]) );   
            },
            Value.zero
        );

        totInputValue = _mint instanceof Value ? Value.add( totInputValue, _mint ) : totInputValue; 

        function indexOfPolicy( policy: Hash32 ): number
        {
            const policyStr = policy.toString();
            return _mint?.map.findIndex( entry => entry.policy.toString() === policyStr ) ?? -1;
        }

        dummyMintRedeemers.forEach( ([ policy, toExec, dummyRdmr ]) => {

            const i = indexOfPolicy( policy );

            mintRedeemers.push(new TxRedeemer({
                data: dummyRdmr.data,
                index: i - 1, // "- 1" because final value will exclude lovelaces (can't mint or burn ADA)
                execUnits: dummyRdmr.execUnits,
                tag: TxRedeemerTag.Mint
            }));

            pushScriptToExec( i, TxRedeemerTag.Mint, toExec );

        })

        const _certs = certificates?.map( ({
            cert,
            script
        }, i) => {
            if( script !== undef )
            {
                certRedeemers.push(new TxRedeemer({
                    data: forceData( script.redeemer ),
                    index: i,
                    execUnits: dummyExecBudget.clone(),
                    tag: TxRedeemerTag.Cert
                }));

                const toExec = checkScriptAndPushIfInline( script );

                pushScriptToExec( i, TxRedeemerTag.Cert, toExec );

            }
            return cert;
        })

        const _wits = withdrawals
        ?.sort( ({ withdrawal: fst }, { withdrawal: snd }) =>
            lexCompare(
                fst.rewardAccount instanceof Hash28 ?
                    fst.rewardAccount.toBuffer() :
                    fst.rewardAccount.credentials.toBuffer(),
                snd.rewardAccount instanceof Hash28 ?
                    snd.rewardAccount.toBuffer() :
                    snd.rewardAccount.credentials.toBuffer()
            )
        )
        .map( ({
            withdrawal,
            script
        },i) => {

            if( script !== undef )
            {
                withdrawRedeemers.push(new TxRedeemer({
                    data: forceData( script.redeemer ),
                    index: i,
                    execUnits: dummyExecBudget.clone(),
                    tag: TxRedeemerTag.Withdraw
                }));

                const toExec = checkScriptAndPushIfInline( script );

                pushScriptToExec( i, TxRedeemerTag.Withdraw, toExec );
            }

            return withdrawal; 
        });

        const _votingProcedures = Array.isArray( votingProcedures ) ?
        new VotingProcedures(
            votingProcedures?.map(({ votingProcedure, script }, i) => {

                if( script !== undef )
                {
                    voteRedeemers.push(
                        new TxRedeemer({
                            data: forceData( script.redeemer ),
                            index: i,
                            execUnits: dummyExecBudget.clone(),
                            tag: TxRedeemerTag.Voting
                        })
                    );

                    const toExec = checkScriptAndPushIfInline( script );

                    pushScriptToExec( i, TxRedeemerTag.Voting, toExec );
                }

                return votingProcedure;
            })
        ) : undef;

        // TODO
        const _proposalProcedures = Array.isArray( proposalProcedures ) ? 
        proposalProcedures.map(({ proposalProcedure, script }, i) => {

            if( script !== undef )
            {
                voteRedeemers.push(
                    new TxRedeemer({
                        data: forceData( script.redeemer ),
                        index: i,
                        execUnits: dummyExecBudget.clone(),
                        tag: TxRedeemerTag.Proposing
                    })
                );

                const toExec = checkScriptAndPushIfInline( script );

                pushScriptToExec( i, TxRedeemerTag.Proposing, toExec );
            }

            return new ProposalProcedure( proposalProcedure );
        }) : undef;

        const auxData = metadata !== undefined? new AuxiliaryData({ metadata }) : undefined;

        const redeemers =
            spendRedeemers
            .concat( mintRedeemers )
            .concat( withdrawRedeemers )
            .concat( certRedeemers )
            .concat( voteRedeemers )
            .concat( proposeRedeemers );
        
        const dummyTxWitnesses = new TxWitnessSet({
            vkeyWitnesses,
            bootstrapWitnesses,
            datums,
            redeemers,
            nativeScripts: nativeScriptsWitnesses,
            plutusV1Scripts: plutusV1ScriptsWitnesses,
            plutusV2Scripts: plutusV2ScriptsWitnesses,
            plutusV3Scripts: plutusV3ScriptsWitnesses
        });

        const datumsScriptData =
            datums.length > 0 ?
                Array.from(
                    Cbor.encode(

                        new CborArray(
                            datums.map( dataToCborObj )
                        )
                        
                    ).toBuffer()
                ) 
            : [];

        const languageViews = costModelsToLanguageViewCbor(
            this.protocolParamters.costModels,
            {
                mustHaveV1: _hasV1Scripts,
                mustHaveV2: _hasV2Scripts
            }
        ).toBuffer();

        invalidBefore = invalidBefore === undef ? undef : forceBigUInt( invalidBefore );

        // if( invalidAfter !== undef )
        // {
        //     if( invalidBefore === undef ) invalidBefore = 0;
        // }

        if(
            canBeUInteger( invalidBefore ) &&
            canBeUInteger( invalidAfter )
        )
        {
            if( invalidBefore >= invalidAfter  )
            throw new Error(
                "invalid validity interval; invalidAfter: "
                + invalidAfter.toString() +
                "; was smaller (previous point in time) than invalidBefore:"
                + invalidBefore.toString()
            );
        }

        // assert collateral is present if needed
        if( scriptsToExec.filter( s => s.script.type !== "NativeScript" ).length > 0 )
        {
            if(
                !Array.isArray( collaterals ) ||
                collaterals.length <= 0
            )
            throw new Error("tx includes plutus scripts to execute but no collateral input was provided");

            const collateralValue = collaterals.reduce<Value>(
                (accum, collateral) => Value.add( accum, collateral.resolved.value ),
                Value.zero
            );

            if( !Value.isAdaOnly( collateralValue ) )
            {
                if( !collateralReturn )
                throw new Error(
                    `total collateral input value was including non-ADA value; no collateral return was specified\n` +
                    `total collateral input value was: ${JSON.stringify( collateralValue.toJson(), undef, 2 )}`
                );

                const realCollValue = Value.sub(
                    collateralValue,
                    collateralReturn.value
                );

                if( !Value.isAdaOnly( realCollValue ) )
                throw new Error(
                    `total collateral value was including non-ADA value;\n` +
                    `total collateral value was: ${JSON.stringify( realCollValue.toJson(), undef, 2 )}`
                );
            }
        }

        const dummyTx = new Tx({
            body: new TxBody({
                inputs: _inputs,
                outputs: dummyOuts,
                fee: dummyFee,
                mint: _mint,
                certs: _certs,
                withdrawals: _wits,
                refInputs: refIns.length === 0 ? undef : refIns.map( refIn => refIn instanceof TxIn ? refIn : new TxIn( refIn ) ),
                // protocolUpdate: protocolUpdateProposal,
                requiredSigners,
                collateralInputs: collaterals,
                collateralReturn:
                    collateralReturn === undef ? 
                    undef : 
                    txBuildOutToTxOut( collateralReturn ),
                totCollateral: undef,
                validityIntervalStart:
                    invalidBefore === undef ?
                    undef :
                    forceBigUInt( invalidBefore ),
                ttl:
                    invalidAfter === undef ?
                    undef :
                    forceBigUInt( invalidAfter ),
                auxDataHash: auxData?.hash,
                scriptDataHash: getScriptDataHash( redeemers, datumsScriptData, languageViews ),
                network,
                votingProcedures: _votingProcedures,
                proposalProcedures: _proposalProcedures,
                currentTreasuryValue: currentTreasuryValue,
                donation: paymentToTreasury,
            }),
            witnesses: dummyTxWitnesses,
            auxiliaryData: auxData,
            isScriptValid
        });

        const minFeeMultiplier = forceBigUInt( this.protocolParamters.txFeePerByte );

        const nVkeyWits = BigInt( getNSignersNeeded( dummyTx.body ) );

        const minFee = this.calcLinearFee( dummyTx ) +
            // consider also vkeys witnesses to be added
            // each vkey witness has fixed size of 102 cbor bytes
            // (1 bytes cbor array tag (length 2)) + (34 cbor bytes of length 32) + (67 cbor bytes of length 64)
            // for a fixed length of 102
            BigInt( 102 ) * nVkeyWits * minFeeMultiplier +
            // we add some more bytes for the array tag
            BigInt( nVkeyWits < 24 ? 1 : (nVkeyWits < 256 ? 2 : 3) ) * minFeeMultiplier;

        const txOuts: TxOut[] = new Array( outs.length + 1 ); 
        outs.forEach( (txO,i) => txOuts[i] = txO.clone() );
        txOuts[txOuts.length - 1] = (
            new TxOut({
                address: change.address,
                value: Value.sub(
                    totInputValue,
                    Value.add(
                        requiredOutputValue,
                        Value.lovelaces( minFee )
                    )
                ),
                datum: change.datum ? (
                    change.datum instanceof Hash32 ?
                    change.datum :
                    forceData( change.datum )
                ): undef,
                refScript: change.refScript
            })
        );

        let tx = new Tx({
            ...dummyTx,
            body: new TxBody({
                ...dummyTx.body,
                outputs: txOuts,
                fee: minFee
            })
        });

        return {
            tx,
            scriptsToExec,
            minFee,
            datumsScriptData,
            languageViews,
            totInputValue,
            requiredOutputValue,
            outs,
            change
        };
    }
}

type ScriptToExecEntry = {
    rdmrTag: TxRedeemerTag,
    index: number,
    script: {
        type: ScriptType,
        bytes: Uint8Array,
        hash: string
    },
    datum?: Data
};

function eqUTxOByRef( a: UTxO, b: UTxO ): boolean
{
    return a === b || a.utxoRef === b.utxoRef || (
        a.utxoRef.index === b.utxoRef.index &&
        a.utxoRef.id.toString() === b.utxoRef.id.toString()
    );
}

function pushUniqueScript<T extends ScriptType>( arr: Script<T>[], toPush: Script<T> ): void
{
    const hashToPush = toPush.hash.toString();
    if(
        !arr.some( script => script.hash.toString() === hashToPush )
    ) arr.push( toPush );
}

function getCtx(
    scriptType: ScriptType,
    spendingPurpose: DataConstr,
    txInfosV1: Data | undefined,
    txInfosV2: Data | undefined,
    txInfosV3: Data
): DataConstr
{
    if( scriptType === ScriptType.PlutusV3 )
    {
        return new DataConstr(
            0, [
                txInfosV3,
                spendingPurpose
            ]
        )
    }
    else if( scriptType === ScriptType.PlutusV2 )
    {
        if( txInfosV2 === undefined )
        throw new Error(
            "plutus script v1 included in a v2 transaction"
        );
        
        return new DataConstr(
            0, [
                txInfosV2,
                spendingPurpose
            ]
        );
    }
    else if( scriptType === ScriptType.PlutusV1 )
    {
        if( txInfosV1 === undefined )
        throw new Error(
            "plutus script v1 included in a v2 or v3 transaction"
        );

        return new DataConstr(
            0,
            [
                txInfosV1,
                spendingPurpose
            ]
        );
    }
    else throw new Error(
        "unexpected native script execution"
    );
}

function onEvaluationResult(
    i: number,
    totExBudget: ExBudget,
    rdmr: TxRedeemer,
    result: UPLCTerm, 
    budgetSpent: ExBudget, 
    logs: string[],
    callArgs: Data[],
    rdmrs: TxRedeemer[],
    onScriptResult: ((rdmr: TxRedeemer, result: UPLCTerm, exBudget: ExBudget, logs: string[], callArgs: Data[]) => void) | undefined,
    onScriptInvalid: ((rdmr: TxRedeemer, logs: string[], callArgs: Data[]) => void) | undefined
): boolean
{
    let _isScriptValid = true;

    // artificially add some budget to allow for small exec costs errors
    // TODO: fix `plutus-machine` evaluation
    budgetSpent.add({
        cpu: 100_000,
        mem: 10_000
    });

    onScriptResult && onScriptResult(
        rdmr.clone(),
        result,
        budgetSpent.clone(),
        logs.slice(),
        callArgs.map( d => d.clone() )
    );

    if(
        result instanceof ErrorUPLC || 
        ((resultKeys) =>
            resultKeys.includes("msg") && 
            resultKeys.includes("addInfos")
        )(Object.keys( result ))
    )
    {
        if( typeof onScriptInvalid === "function" )
        {
            onScriptInvalid( rdmr.clone(), logs.slice(), callArgs.map( d => d.clone() ) );
            _isScriptValid = false;
        }
        else
        {
            throw new Error(
                `script consumed with ${txRedeemerTagToString(rdmr.tag)} redemer ` +
                `and index '${rdmr.index.toString()}'\n\n` +
                `called with data arguments:\n${
                    callArgs
                    .map( (d, i) =>
                        (
                            i === 0 ? ( rdmr.tag === TxRedeemerTag.Spend ? "datum" : "redeemer" ) :
                            i === 1 ? ( rdmr.tag === TxRedeemerTag.Spend ? "redeemer" : "script context" ) :
                            i === 2 ? ( rdmr.tag === TxRedeemerTag.Spend ? "script context" : i.toString() ) :
                            i.toString()
                        ) + ": " + dataToCbor( d ).toString()
                    )
                    .join("\n")
                }\n\n` +
                `failed with \n`+
                `error message: ${(result as any).msg}\n`+ 
                `additional infos: ${
                    JSON.stringify(
                        (result as any).addInfos,
                        ( k, v ) => {
                            if( isUint8Array( v ) )
                            return toHex( v );

                            if( typeof v === "bigint" )
                            return v.toString();

                            return v
                        }
                    )
                }\n` +
                `script execution logs: [${logs.toString()}]\n`
            );
        }
    }

    rdmrs[i] = new TxRedeemer({
        ...rdmr,
        execUnits: budgetSpent
    });

    totExBudget.add( budgetSpent );

    return _isScriptValid;
};

export function getScriptDataHash( rdmrs: TxRedeemer[], datumsScriptData: number[], languageViews: Uint8Array ): ScriptDataHash | undefined
{
    const undef = void 0;

    const scriptData =
        rdmrs.length === 0 && datumsScriptData.length === 0 ?
        undef : 
        rdmrs.length === 0 && datumsScriptData.length > 0 ?
        /*
        ; in the case that a transaction includes datums but does not
        ; include any redeemers, the script data format becomes (in hex):
        ; [ 80 | datums | A0 ]
        ; corresponding to a CBOR empty list and an empty map.
        */
        [ 0x80, ...datumsScriptData, 0xa0 ] as byte[] :
        /*
        ; script data format:
        ; [ redeemers | datums | language views ]
        ; The redeemers are exactly the data present in the transaction witness set.
        ; Similarly for the datums, if present. If no datums are provided, the middle
        ; field is an empty string.
        */
        Array.from(
            Cbor.encode(
                new CborArray(
                    rdmrs.map( r => r.toCborObj() )
                )
            ).toBuffer()
        )
        .concat(
            datumsScriptData
        )
        .concat(
            Array.from(
                languageViews
            )
        ) as byte[];

    return scriptData === undef ? undef :
        new ScriptDataHash(
            Uint8Array.from(
                blake2b_256( scriptData )
            )
        );
}