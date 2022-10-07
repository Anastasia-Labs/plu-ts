import { TypeName, TermTypeParameter, FixedTypeName, PrimType, FixedDataTypeName, DataConstructor, TermType, FixedTermDataType, FixedTermType, DataType, ConstantableTermType, StructType, structType, anyStruct, ConstantableStructType } from ".";
import { isStructDefinition } from "../../PTypes/PStruct";

export function isTypeParam( tyName: TypeName | TermType ): tyName is TermTypeParameter
{
    return Array.isArray( tyName ) ?
        (tyName.length > 0 && isTypeParam( tyName[0] ) ) :
        (
            typeof tyName === "symbol" && 
            tyName !== structType
        );
}

export function isFixedTypeNameOfPrim( tyName: TypeName ): tyName is FixedTypeName
{
    return (
        tyName === PrimType.Int     ||
        tyName === PrimType.BS      ||
        tyName === PrimType.Str     ||
        tyName === PrimType.Unit    ||
        tyName === PrimType.Bool    ||
        tyName === PrimType.List    ||
        tyName === PrimType.Pair    ||
        tyName === PrimType.Delayed ||
        tyName === PrimType.Lambda
    );
}

export function isTypeNameOfPrimitive( tyName: TypeName ): tyName is PrimType
{
    return ( isFixedTypeName( tyName ) );
}

export function isFixedDataTypeName( tyName: TypeName ): tyName is FixedDataTypeName
{
    return (
        tyName === DataConstructor.Constr   ||
        tyName === DataConstructor.Pair     ||
        tyName === DataConstructor.List     ||
        tyName === DataConstructor.Int      ||
        tyName === DataConstructor.BS
    );
}

export function isTypeNameOfData( tyName: TypeName ): tyName is DataConstructor
{
    return (
        tyName === DataConstructor.Any      ||
        isFixedDataTypeName( tyName )
    );
}

export function isTypeName( tyName: TypeName ): tyName is TypeName
{
    return (
        isTypeNameOfPrimitive( tyName ) ||
        isTypeNameOfData( tyName )      ||
        isTypeParam( tyName )
    );
}

export function isFixedTypeName( tyName: TypeName ): tyName is FixedTypeName
{
    return ( isFixedTypeNameOfPrim( tyName ) || isFixedDataTypeName( tyName ) )
}

export function isFixedDataType( t: TermType ): t is FixedTermDataType
{
    if(!( Array.isArray( t ) && t.length > 0 &&  isFixedDataTypeName( t[0] ) )) return false;
    if( t.length === 1 )
    {
        return (
            t[ 0 ] === DataConstructor.Constr   ||
            t[ 0 ] === DataConstructor.BS       ||
            t[ 0 ] === DataConstructor.Int
        )
    }
    if( t.length === 2 )
        return (
            t[0] === DataConstructor.List &&
            isFixedDataType( t[ 1 ] )
        );
    if( t.length === 3 )
        return (
            t[ 0 ] === DataConstructor.Pair &&
            isFixedDataType( t[ 1 ] ) && isFixedDataType( t[ 2 ] )
        );
    
    return false;
}

export function isFixedType( t: TermType ): t is FixedTermType
{
    if(!( Array.isArray( t ) && t.length > 0 && isFixedTypeName( t[0] ) )) return false;
    
    if( isFixedDataType( t ) ) return true;
    
    if( t.length === 1) return (
        t[ 0 ] === PrimType.BS      ||
        t[ 0 ] === PrimType.Bool    ||
        t[ 0 ] === PrimType.Int     ||
        t[ 0 ] === PrimType.Str     ||
        t[ 0 ] === PrimType.Unit
    );    
    if( t.length > 3 ) return false;
    
    if( t.length === 2 )
    {        
        if(
            t[0] === PrimType.List    ||
            t[0] === PrimType.Delayed
        )
        {
            return isFixedType( t[ 1 ] );
        }

        return false;
    }

    if( t.length === 3 )
    {
        return (
            (
                t[0] === PrimType.Pair   ||
                t[0] === PrimType.Lambda
            ) &&
            isFixedType( t[ 1 ] ) && isFixedType( t[ 2 ] )
        )
    }

    return false;
}

export function isDataType( t: TermType ): t is DataType
{
    if(!( Array.isArray( t ) && t.length > 0 &&  isTypeNameOfData( t[0] ) )) return false;
    if( t.length === 1 )
    {
        return (
            t[ 0 ] === DataConstructor.Constr   ||
            t[ 0 ] === DataConstructor.BS       ||
            t[ 0 ] === DataConstructor.Int      ||
            t[ 0 ] === DataConstructor.Any
        )
    }
    if( t.length === 2 )
        return (
            t[0] === DataConstructor.List &&
            isDataType( t[ 1 ] )
        );
    if( t.length === 3 )
        return (
            t[ 0 ] === DataConstructor.Pair &&
            isDataType( t[ 1 ] ) && isDataType( t[ 2 ] )
        );
    
    return false;
}


export function isStructType( t: TermType ): t is StructType
{
    return t[0] === structType;
}

export function isConstantableStructType( t: StructType ): t is ConstantableStructType
{
    if( !isStructType( t ) || typeof t[1] === "symbol" ) return false;

    const def = t[1];
    const ctors = Object.keys( def );

    for( let i = 0; i < ctors.length; i++ )
    {
        const thisCtor = def[ ctors[i] ];
        const fields = Object.keys( thisCtor );

        if( 
            !fields.every( field =>
                isConstantableTermType( thisCtor[ field ] )
            )
        ) return false;
    }

    return true;
}

export function isConstantableTermType( t: TermType ): t is ConstantableTermType
{
    if(!( Array.isArray( t ) && t.length > 0 &&  (isTypeName( t[0] || t[0] === structType) ) )) return false;

    if( isStructType( t ) )
    {
        return isConstantableStructType( t );
    }

    // any data can be constant
    if( isDataType( t ) ) return true;

    if( t.length === 1) return (
        t[ 0 ] === PrimType.BS      ||
        t[ 0 ] === PrimType.Bool    ||
        t[ 0 ] === PrimType.Int     ||
        t[ 0 ] === PrimType.Str     ||
        t[ 0 ] === PrimType.Unit
    );  
    if( t.length > 3 ) return false;

    if( t.length === 2 )
    {        
        return ( t[0] === PrimType.List && isConstantableTermType( t[ 1 ] ) );
    }

    if( t.length === 3 )
    {
        return (
            t[0] === PrimType.Pair &&
            isConstantableTermType( t[ 1 ] ) && isConstantableTermType( t[ 2 ] )
        );
    }

    return false;
}

export function isWellFormedType( t: TermType ): t is TermType
{
    if(!( Array.isArray( t ) && t.length > 0 && (isTypeName( t[0] ) || t[0] === structType) )) return false;
    
    if( t.length === 1) return true;

    if( t[0] === structType )
    {
        return (
            t[1] === anyStruct ||
            isStructDefinition( t[1] )
        );
    }

    if( t.length > 3 ) return false;
    
    if( isDataType( t ) ) return true;
    if( t.length === 2 )
    {        
        if(
            t[0] === PrimType.List    ||
            t[0] === PrimType.Delayed
        )
        {
            return isWellFormedType( t[ 1 ] );
        }

        return false;
    }

    if( t.length === 3 )
    {
        return (
            (
                t[0] === PrimType.Pair   ||
                t[0] === PrimType.Lambda
            ) &&
            isWellFormedType( t[ 1 ] ) && isWellFormedType( t[ 2 ] )
        )
    }

    return false;
}

export function isListType( t: TermType ): t is [ PrimType.List, TermType ]
{
    return (
        Array.isArray( t ) &&
        t.length === 2 &&
        t[0] === PrimType.List &&
        isWellFormedType( t[ 1 ] )
    )
}

export function isDelayedType( t: TermType ): t is [ PrimType.Delayed, TermType ]
{
    return (
        Array.isArray( t ) &&
        t.length === 2 &&
        t[0] === PrimType.Delayed &&
        isWellFormedType( t[ 1 ] )
    )
}

export function isLambdaType( t: TermType ): t is [ PrimType.Lambda, TermType, TermType ]
{
    return (
        Array.isArray( t ) &&
        t.length === 3 &&
        t[0] === PrimType.Lambda &&
        isWellFormedType( t[ 1 ] ) && isWellFormedType( t[ 2 ] )
    );
}

export function isPairType( t: TermType ): t is [ PrimType.Pair, TermType, TermType ]
{
    return (
        Array.isArray( t ) &&
        t.length === 3 &&
        t[0] === PrimType.Pair &&
        isWellFormedType( t[ 1 ] ) && isWellFormedType( t[ 2 ] )
    );
}