import { IRDelayed } from "./IRDelayed";
import { IRMetadata } from "../interfaces/IRMetadata";
import { prettyIRJsonStr } from "../utils/showIR";
import { Cloneable } from "@harmoniclabs/cbor/dist/utils/Cloneable";
import { blake2b_128 } from "@harmoniclabs/crypto";
import { freezeAll, defineProperty } from "@harmoniclabs/obj-utils";
import { toHex, uint8ArrayEq } from "@harmoniclabs/uint8array-utils";
import { BasePlutsError } from "../../utils/BasePlutsError";
import { ToJson } from "../../utils/ToJson";
import { IRTerm } from "../IRTerm";
import { IHash, IIRParent } from "../interfaces";
import { concatUint8Arr } from "../utils/concatUint8Arr";
import { isClosedIRTerm } from "../utils/isClosedIRTerm";
import { isIRTerm } from "../utils/isIRTerm";
import { IRApp } from "./IRApp";
import { IRForced } from "./IRForced";
import { IRFunc } from "./IRFunc";
import { IRLetted } from "./IRLetted";
import { handleLetted } from "../toUPLC/subRoutines/handleLetted";
import { IRParentTerm, isIRParentTerm } from "../utils/isIRParentTerm";
import { _modifyChildFromTo } from "../toUPLC/_internal/_modifyChildFromTo";
import { IRConstr } from "./IRConstr";
import { IRCase } from "./IRCase";


export type HoistedSetEntry = {
    hoisted: IRHoisted,
    nReferences: number
}

export interface IRHoistedMeta {
    /**
     * force hoisting even if only a single reference is found
     * 
     * useful to hoist terms used once in recursive expressions
    **/
    forceHoist?: boolean,
    name?: string | undefined
}

export interface IRHoistedMetadata extends IRMetadata {
    meta: IRHoistedMeta
}

const defaultHoistedMeta: IRHoistedMeta = freezeAll({
    forceHoist: false
});

export class IRHoisted
    implements Cloneable<IRHoisted>, IHash, IIRParent, ToJson, IRHoistedMetadata
{
    readonly hash!: Uint8Array;
    markHashAsInvalid!: () => void;
    isHashPresent: () => boolean;

    hoisted!: IRTerm

    // `IRHoisted` can have only other `IRHoisted` as deps
    readonly dependencies!: HoistedSetEntry[];

    parent: IRParentTerm | undefined;

    readonly meta!: IRHoistedMeta

    constructor(
        hoisted: IRTerm, 
        metadata: Partial<IRHoistedMeta> = {},
        _unsafeHash?: Uint8Array
    )
    {
        // unwrap
        // !!! IMPORTANT !!!
        while( hoisted instanceof IRHoisted ) hoisted = hoisted.hoisted;

        if( !isClosedIRTerm( hoisted ) )
        {
            console.log(
                prettyIRJsonStr(
                    hoisted
                )
            )
            throw new BasePlutsError(
                "only closed terms can be hoisted"
            );
        }
        
        // initialize without calling "set"
        let _hoisted: IRTerm = hoisted;
        _hoisted.parent = this;
        
        let _deps: HoistedSetEntry[] | undefined = undefined;
        function _getDeps(): HoistedSetEntry[]
        {
            if( _deps === undefined )
            _deps = getSortedHoistedSet( getHoistedTerms( _hoisted ) );
            return _deps;
        }

        let hash: Uint8Array | undefined = _unsafeHash;
        Object.defineProperty(
            this, "hash", {
                get: () => {
                    if(!( hash instanceof Uint8Array ))
                    {
                        hash = blake2b_128(
                            concatUint8Arr(
                                IRHoisted.tag,
                                hoisted.hash
                            )
                        )
                    }
                    return hash.slice();
                },
                set: () => {},
                enumerable: true,
                configurable: false
            }
        );
        Object.defineProperty(
            this, "isHashPresent", {
                value: () => hash instanceof Uint8Array,
                writable: false,
                enumerable: true,
                configurable: false
            }
        );
        Object.defineProperty(
            this, "markHashAsInvalid",
            {
                value: () => { 
                    hash = undefined;
                    // tree changed; possibly dependencies too
                    _deps = undefined;
                    this.parent?.markHashAsInvalid();
                },
                writable: false,
                enumerable:  false,
                configurable: false
            }
        );

        Object.defineProperty(
            this, "hoisted",
            {
                get: () => _hoisted,
                set: ( newHoisted: IRTerm ) => {
                    if( !isClosedIRTerm( hoisted ) )
                    throw new BasePlutsError(
                        "only closed terms can be hoisted"
                    );
                    this.markHashAsInvalid();
                    _deps = undefined;
                    _hoisted = newHoisted;
                    _hoisted.parent = this
                }
            }
        );

        Object.defineProperty(
            this, "dependencies",
            {
                get: (): HoistedSetEntry[] => {

                    return _getDeps()
                    /*
                    .map( dep => {

                        // const hoisted = dep.hoisted.clone();
                        // hoisted.parent = dep.hoisted.parent;
                        return {
                            hoisted: dep.hoisted,
                            nReferences: dep.nReferences
                        };
                    })
                    //*/
                    ;
                }, // MUST return clones
                set: () => {},
                enumerable: true,
                configurable: false
            }
        );

        let _parent: IRParentTerm | undefined = undefined;
        Object.defineProperty(
            this, "parent",
            {
                get: () => _parent,
                set: ( newParent: IRParentTerm | undefined ) => {
                    if(!( // assert
                        // new parent value is different than current
                        _parent !== newParent && (
                            // and the new parent value is valid
                            newParent === undefined || 
                            isIRParentTerm( newParent )
                        )
                    )) return;
                    
                    // keep reference
                    const oldParent = _parent;
                    // change parent
                    _parent = newParent;

                    // if has old parent
                    if( oldParent !== undefined && isIRParentTerm( oldParent ) )
                    {
                        // change reference to a clone for safety
                        _modifyChildFromTo(
                            oldParent,
                            this,
                            this.clone()
                        );
                    }
                },
                enumerable: true,
                configurable: false
            }
        );

        Object.defineProperty(
            this, "meta",
            {
                value: {
                    ...defaultHoistedMeta,
                    ...metadata,
                    name: _hoisted.meta.name ?? metadata.name
                },
                writable: false,
                enumerable: true,
                configurable: false
            }
        );
        
    }

    static get tag(): Uint8Array { return new Uint8Array([ 0b0000_0110 ]); }

    clone(): IRHoisted
    {
        return new IRHoisted(
            this.hoisted.clone(),
            { ...this.meta },
            this.isHashPresent() ? this.hash : undefined
        )
    }

    toJson(): any
    {
        return {
            type: "IRHoisted",
            hash: toHex( this.hash ),
            hoisted: this.hoisted.toJson()
        }
    }
}


/**
 * basically an insertion sort;
 * 
 * @param {HoistedSetEntry[]} hoistedTerms
 * @returns {HoistedSetEntry[]} a **new** array with ```IRHoisted```s with no dependencies first, followed by the dependents
 */
export function getSortedHoistedSet( hoistedTerms: HoistedSetEntry[] ): HoistedSetEntry[]
{
    const set: HoistedSetEntry[] = [];
    const hashesSet: Uint8Array[] = [];
     
    /**
     * **O((n * m) * d)**
     * 
     * where
     * 
     *      n = length of set
     *      m = number of terms passed
     *      d = number of unique dependencies among the passed terms
     */
    function addToSet( ..._terms: HoistedSetEntry[] ): void
    {
        for( let i = 0; i < _terms.length; i++ )
        {
            const thisHoistedEntry = _terms[i]; 
            const thisHash = thisHoistedEntry.hoisted.hash;

            const idxInSet = hashesSet.findIndex( hash => uint8ArrayEq( hash, thisHash ) )

            // if( !hashesSet.includes( compiled ) )
            // "includes" uses standard equality (===)
            if( idxInSet < 0 ) // not present
            {
                // add dependencies first
                addToSet( ..._terms[ i ].hoisted.dependencies );

                hashesSet.push( thisHash );
                set.push( thisHoistedEntry );
            }
            else
            {
                const entry = set[ idxInSet ]; 
                entry.nReferences += thisHoistedEntry.nReferences;
                entry.hoisted.meta.forceHoist = 
                    entry.hoisted.meta.forceHoist || 
                    thisHoistedEntry.hoisted.meta.forceHoist;
            }
        }
    }

    addToSet( ...hoistedTerms );

    return set;
}

export function getHoistedTerms( irTerm: IRTerm ): HoistedSetEntry[]
{
    const hoisteds: HoistedSetEntry[] = [];

    function searchIn( term: IRTerm ): void
    {
        if( term instanceof IRHoisted )
        {
            // only push direct hoisteds
            // dependencies are counted calling `getSortedHoistedSet`
            hoisteds.push({ hoisted: term, nReferences: 1 });
            return;
        }

        if( term instanceof IRApp )
        {
            searchIn( term.fn );
            searchIn( term.arg );
            return;
        }

        if( term instanceof IRConstr )
        {
            for( let i = 0; i < term.fields.length; i++ )
            {
                searchIn( term.fields[i] );
            }
            return;
        }
        if( term instanceof IRCase )
        {
            searchIn( term.constrTerm );
            for( let i = 0; i < term.continuations.length; i++ )
            {
                searchIn( term.continuations[i] );
            }
            return;
        }

        if( term instanceof IRFunc )
        {
            searchIn( term.body );
            return;
        }
        if( term instanceof IRLetted )
        {
            // useless
            // term.dependencies.forEach( searchIn )
            // dependecies are still in the body anyway (hoisted are closed)

            // experiment to remove new letted;
            // no good so far
            // handleLetted( term );
            
            searchIn( term.value );
            return;
        }

        if( term instanceof IRForced )
        {
            searchIn( term.forced );
            return;
        }

        if( term instanceof IRDelayed )
        {
            searchIn( term.delayed );
            return;
        }

        // if( term instanceof IRNative ) return;
        // if( term instanceof IRVar ) return;
        // if( term instanceof IRConst ) return;
        // if( term instanceof IRError ) return;
    }

    searchIn( irTerm );

    return hoisteds;
}

export function cloneHoistedSetEntry({hoisted, nReferences}: HoistedSetEntry ): HoistedSetEntry
{
    return {
        hoisted: hoisted.clone(),
        nReferences
    };
}