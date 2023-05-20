import { DataSchema, DataSchemaConstr, DataSchemaList, DataSchemaMap } from "./types";
import { PrimType, TermType, bs, data, int, isTaggedAsAlias, list, map, typeExtends, unwrapAlias } from "../../type_system";
import { getElemsT, getFstT, unwrapAsData } from "../../type_system/tyArgs";
import { tyVar } from "@harmoniclabs/plu-ts-onchain";

export function toDataSchema( t: TermType ): DataSchema
{
    while( isTaggedAsAlias( t ) ) t = unwrapAlias( t );

    if( t[0] === PrimType.AsData && typeExtends( t[1], int ) )
    return { dataType: "integer" }
    if( typeExtends( t, int ) )
    return { dataType: "#integer" };

    if( t[0] === PrimType.AsData && typeExtends( t[1], bs ) )
    return { dataType: "bytes" }
    if(typeExtends( t, bs ) )
    return { dataType: "#bytes" };

    if(
        t[0] === PrimType.AsData &&
        t[1][0] === PrimType.List &&
        t[1][1][0] === PrimType.Pair
    )
    {
        const schema: DataSchemaMap = { dataType: "map" };
        const keysSchema  = toDataSchemaAsData( getElemsT( t )[1] as TermType );
        const valueSchema = toDataSchemaAsData( getElemsT( t )[2] as TermType );
    
        if( keysSchema.dataType )
        {
            schema.keys = keysSchema;
        }
        if( valueSchema.dataType )
        {
            schema.values = valueSchema;
        }
    
        return schema;
    }
    if( typeExtends( t, map( data, data ) ) )
    {
        throw new Error("unsupported #list( #pair( ... , ... ) ); only lists as data please");
    }

    if(
        t[0] === PrimType.AsData &&
        t[1][0] === PrimType.List &&
        typeExtends( t[1][1], data )
    ) return { dataType: "list" }
    if( typeExtends( t, list( data )) )
    return { dataType: "#list" };

}

export function toDataSchemaAsData( t: TermType, title?: string | undefined ): DataSchema
{
    while( isTaggedAsAlias( t ) || t[0] === PrimType.AsData ) t = unwrapAlias( unwrapAsData( t as any ) );

    title = typeof title === "string" ? title : undefined;

    if( typeExtends( t, int ) ) 
    return { dataType: "integer", title };

    if( typeExtends( t, bs ) )
    return { dataType: "bytes", title };

    if( typeExtends( t, map( tyVar(), tyVar() ) ) )
    {
        const schema: DataSchemaMap = { dataType: "map", title };
        const keysSchema  = toDataSchemaAsData( getElemsT( t )[1] as TermType );
        const valueSchema = toDataSchemaAsData( getElemsT( t )[2] as TermType );
    
        if( keysSchema.dataType )
        {
            schema.keys = keysSchema;
        }
        if( valueSchema.dataType )
        {
            schema.values = valueSchema;
        }
    
        return schema;
    }

    if( typeExtends( t, list( tyVar() ) ) )
    {
        const schema: DataSchemaList = { dataType: "list", title };
        const itemsSchema = toDataSchemaAsData( getElemsT( t ) );
        if( itemsSchema.dataType )
        {
            schema.items = itemsSchema;
        }
        return schema;
    }

    if( t[0] === PrimType.Struct )
    {
        const def = t[1];
        const ctors = Object.keys( def );

        if( ctors.length === 1 )
        {
            const ctor = ctors[0];
            const ctorDef = def[ ctor ];
            const fieldNames = Object.keys( def[ ctor ] );
            return {
                dataType: "constructor",
                title: ctor.toString(),
                index: 0,
                fields: fieldNames.map( field => toDataSchemaAsData( ctorDef[ field ], field ) )
            };
        }
        
        const len = ctors.length;
        const alternatives: DataSchemaConstr[] = new Array( len );

        for( let i = 0; i < len; i++ )
        {
            const ctor = ctors[i];
            const ctorDef = def[ ctor ];
            const fieldNames = Object.keys( def[ ctor ] );
            alternatives[i] = {
                dataType: "constructor",
                title: ctor.toString(),
                index: i,
                fields: fieldNames.map( field => toDataSchemaAsData( ctorDef[ field ], field ) )
            }
        }

        return {
            anyOf: alternatives,
            title
        }
    }
}