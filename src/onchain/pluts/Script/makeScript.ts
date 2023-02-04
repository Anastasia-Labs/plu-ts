import { BasePlutsError } from "../../../errors/BasePlutsError";
import type { PBool } from "../PTypes/PBool";
import type { PData } from "../PTypes/PData/PData";
import type { PLam } from "../PTypes/PFn/PLam";
import type { PUnit } from "../PTypes/PUnit";
import type { Term } from "../Term";
import { bool, data, unit } from "../Term/Type/base";
import { typeExtends } from "../Term/Type/extension";
import { isConstantableTermType, isLambdaType } from "../Term/Type/kinds";
import { termTypeToString } from "../Term/Type/utils";
import { V1 , V2 } from "../API";
import { getFromDataForType } from "../lib/std/data/conversion/getFromDataTermForType";
import type { PDataRepresentable } from "../PType/PDataRepresentable";
import { TermFn } from "../PTypes/PFn/PFn";
import { perror } from "../lib/perror";
import { pmakeUnit } from "../lib/std/unit/pmakeUnit";
import { pif } from "../lib/builtins";
import { papp } from "../lib/papp";
import { pfn } from "../lib/pfn";


export function makeValidator(
    typedValidator: Term<
        PLam<
        PDataRepresentable,
        PLam<
            PDataRepresentable,
            PLam<
                    typeof V1.PScriptContext | typeof V2.PScriptContext, 
                    PBool
                >
            >
        >
    > )
    : TermFn<[PData,PData,PData], PUnit>
{
    return pfn([
        data,
        data,
        data
    ],  unit
    )(( rawDatum, rawRedeemer, rawCtx ) => {

        const vType = typedValidator.type;
        const err = new BasePlutsError(
            "cannot make a validator from a term of type " + termTypeToString( vType )
        );

        if( !isLambdaType( vType ) ) throw err;
        
        const datumType = vType[1];
        if( !isConstantableTermType( datumType ) ) throw  err;

        const postDatum = vType[2];

        if( !isLambdaType( postDatum ) ) throw err;

        const redeemerType = postDatum[1];
        if( !isConstantableTermType( redeemerType ) ) throw  err;

        const postRedeemer = postDatum[2];

        if( !isLambdaType( postRedeemer ) ) throw err;

        const ctxType = postRedeemer[1];
        if( !isConstantableTermType( ctxType ) ) throw err;

        const expectedBool = postRedeemer[2];

        if( !typeExtends( expectedBool, bool ) ) throw err;

        return pif( unit ).$(
                papp(
                    papp(
                        papp(
                            typedValidator,
                            getFromDataForType( datumType )( rawDatum )
                        ),
                        getFromDataForType( redeemerType )( rawRedeemer )
                    ),
                    getFromDataForType( ctxType )( rawCtx )
                )
            )
            .$( pmakeUnit() )
            .$( perror( unit ) );
    });
}


export function makeRedeemerValidator(
    typedValidator: Term<
        PLam<
            PDataRepresentable,
            PLam<
                    typeof V1.PScriptContext | typeof V2.PScriptContext, 
                    PBool
                >
        >
    >
    )
    : TermFn<[PData,PData], PUnit>
{
    return pfn([
        data,
        data
    ],  unit
    )(( rawRedeemer, rawCtx ) => {

        const vType = typedValidator.type;
        const err = new BasePlutsError(
            "cannot make a validator from a term of type " + termTypeToString( vType )
        );

        if( !isLambdaType( vType ) ) throw err;

        const redeemerType = vType[1];
        if( !isConstantableTermType( redeemerType ) ) throw  err;

        const postRedeemer = vType[2];

        if( !isLambdaType( postRedeemer ) ) throw err;

        const ctxType = postRedeemer[1];
        if( !isConstantableTermType( ctxType ) ) throw err;

        const expectedBool = postRedeemer[2];

        if( !typeExtends( expectedBool, bool ) ) throw err;

        return pif( unit ).$(
                papp(
                    papp(
                        typedValidator,
                        getFromDataForType( redeemerType )( rawRedeemer )
                    ),
                    getFromDataForType( ctxType )( rawCtx )
                )
            )
            .$( pmakeUnit() )
            .$( perror( unit ) );
    });
}