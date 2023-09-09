import { toHex, uint8ArrayEq } from "@harmoniclabs/uint8array-utils";
import { IRApp } from "../../../IRNodes/IRApp";
import { IRFunc } from "../../../IRNodes/IRFunc";
import { getSortedLettedSet, getLettedTerms, IRLetted, jsonLettedSetEntry, expandedJsonLettedSetEntry, LettedSetEntry } from "../../../IRNodes/IRLetted";
import { IRVar } from "../../../IRNodes/IRVar";
import { IRTerm } from "../../../IRTerm";
import { _addDepths } from "../../_internal/_addDepth";
import { _modifyChildFromTo } from "../../_internal/_modifyChildFromTo";
import { findAll, findAllNoHoisted } from "../../_internal/findAll";
import { getDebruijnInTerm } from "../../_internal/getDebruijnInTerm";
import { _getMinUnboundDbn, groupByScope } from "./groupByScope";
import { prettyIR, prettyIRJsonStr, showIR } from "../../../utils/showIR";
import { IRDelayed } from "../../../IRNodes/IRDelayed";
import { IRForced } from "../../../IRNodes/IRForced";
import { lowestCommonAncestor } from "../../_internal/lowestCommonAncestor";
import { isIRTerm } from "../../../utils/isIRTerm";
import { markRecursiveHoistsAsForced } from "../markRecursiveHoistsAsForced";
import { IRConst } from "../../../IRNodes/IRConst";
import { incrementUnboundDbns } from "./incrementUnboundDbns";
import { IRError } from "@harmoniclabs/plu-ts-onchain";
import { IRHoisted } from "../../../IRNodes";


function onlyLettedTerm( setEntry: LettedSetEntry ): IRLetted
{
    return setEntry.letted;
}

function lettedHash({ hash }: IRLetted): Uint8Array
{
    return hash;
}

function lettedHashHex({ hash }: IRLetted): string
{
    return toHex( hash );
}

export function handleLetted( term: IRTerm ): void
{
    // most of the time we are just compiling small
    // pre-execuded terms (hence constants)
    if( term instanceof IRConst ) return;
    
    // TODO: should probably merge `markRecursiveHoistsAsForced` inside `getLettedTerms` to iter once
    markRecursiveHoistsAsForced( term );

    const allDirectLetted = getLettedTerms( term, { all: false, includeHoisted: true });

    // in case there are no letted terms there is no work to do
    if( allDirectLetted.length === 0 ) return;

    const allLettedRefs = getLettedTerms( term, { all: true, includeHoisted: true }).map( onlyLettedTerm );
    const sortedLettedSet = getSortedLettedSet( allDirectLetted );

    const allScopes: {
        maxScope: IRFunc,
        lettedRefs: IRLetted[],
        forceHoist: boolean
    }[] = sortedLettedSet.map(({ letted }) => {

        const theHash = letted.hash;
        const allSameLetted = allLettedRefs.filter(({ hash }) => uint8ArrayEq( hash, theHash ) );

        const scopes = new Array<{
            maxScope: IRFunc,
            lettedRefs: IRLetted[],
            forceHoist: boolean
        }>();

        for( const letted of allSameLetted )
        {
            const _maxScope = findLettedMaxScope( letted );
            const idx = scopes.findIndex(({ maxScope }) => maxScope === _maxScope );
            if( idx < 0 )
            {
                scopes.push({
                    maxScope: _maxScope,
                    lettedRefs: [ letted ],
                    forceHoist: letted.meta.forceHoist === true
                });
            }
            else
            {
                scopes[idx].lettedRefs.push( letted );
                scopes[idx].forceHoist ||= (letted.meta.forceHoist === true);
            }
        }

        return scopes;
    }).reduce((a, b) => a.concat( b ))

    // needs to go from last to first so that letted terms' hashes will not change
    // (aka. we replace dependents before dependecies)
    while( allScopes.length > 0 )
    {
        let {
            maxScope,
            lettedRefs: sameLettedRefs,
            forceHoist
        } = allScopes.pop()!;

        // const maxScope = findLettedMaxScope( lettedExampleElem );
        const setLettedHash = sameLettedRefs[0].hash;

        const lettedExampleElem = sameLettedRefs[0];

        if( !lettedExampleElem ) continue;

        // inline single references
        if(
            !forceHoist && 
            sameLettedRefs.length <= 1
        )
        {
            _modifyChildFromTo(
                lettedExampleElem.parent,
                lettedExampleElem,
                lettedExampleElem.value
            );
            continue;
        }

        // always inline letted vars
        if( lettedExampleElem.value instanceof IRVar )
        {
            for( const elem of sameLettedRefs )
            {
                // inline
                _modifyChildFromTo(
                    elem.parent,
                    elem,
                    elem.value
                );
            }
            continue;
        }

        let lca: IRTerm | undefined = sameLettedRefs[0];

        // if `froceHoist` is true;
        // we append directly to `maxScope`
        // hence no need to look for `lca`
        if( !forceHoist )
        {
            for( let j = 1; j < sameLettedRefs.length; j++ )
            {
                lca = lowestCommonAncestor( lca, sameLettedRefs[j], maxScope );
                if( !isIRTerm( lca ) ) break;
            }
    
            if( !isIRTerm( lca ) )
            {
                // default to maxScope
                lca = maxScope;
                throw new Error(
                    "letting nodes with hash " + toHex( setLettedHash ) + " from different trees"
                );
            }
            else
            {
                // point to the first func or delay node above the lca
                // (worst case scenario we hit the maxScope; which is an IRFunc)
                while(!(
                    lca instanceof IRFunc ||
                    lca instanceof IRDelayed
                ))
                {
                    lca = lca?.parent ?? undefined;
                    // if somehow we hit the root
                    if( !isIRTerm( lca ) )
                    {
                        throw new Error(
                            "lowest common ancestor outside the max scope"
                        );
                    }
                }
            }
        }

        const parentNode: IRFunc | IRDelayed = forceHoist ? maxScope : lca as any;
        const parentNodeDirectChild = parentNode instanceof IRFunc ? parentNode.body : parentNode.delayed;

        // add 1 to every var's DeBruijn that accesses stuff outside the parent node
        // not including the `parentNode` node
        // since the new function introdcued substituting the letted term
        // is added inside the `parentNode` node
        incrementUnboundDbns(
            parentNodeDirectChild,
            // shouldNotModifyLetted
            ({ hash }) => uint8ArrayEq( hash, setLettedHash )
        );
        
        // get the difference in DeBruijn
        // between the maxScope and the letted term
        let diffDbn = 0; // getDiffDbn( parentNodeDirectChild, letted );
        //*
        let tmpNode: IRTerm = lettedExampleElem;
        while( tmpNode !== parentNode )
        {
            tmpNode = tmpNode.parent as any;
            if( // is an intermediate `IRFunc`
                tmpNode instanceof IRFunc && 
                tmpNode !== parentNode // avoid counting parent node arity if IRFunc 
            )
            {
                // increment differential in DeBruijn by n vars indroduced here
                diffDbn += tmpNode.arity;
            }
        }
        //*/

        // now we replace
        const lettedValue = lettedExampleElem.value.clone();

        // if there is any actual difference between the letted term
        // and the position where it will be finally placed
        // the value needs to be modified accoridingly
        if( diffDbn > 0 )
        {
            const stack: { term: IRTerm, dbn: number }[] = [{ term: lettedValue, dbn: 0 }];

            while( stack.length > 0 )
            {
                const { term: t, dbn } = stack.pop() as { term: IRTerm, dbn: number };

                if(
                    t instanceof IRVar &&
                    t.dbn > dbn
                )
                {
                    t.dbn -= diffDbn;
                }

                if( t instanceof IRLetted )
                {
                    t.dbn -= diffDbn;
                    // reduce dbn in letted value too
                    stack.push({ term: t.value, dbn });
                    continue;
                }
                
                if( t instanceof IRApp )
                {
                    stack.push(
                        { term: t.arg, dbn },
                        { term: t.fn, dbn  }
                    );
                    continue;
                }
                if( t instanceof IRDelayed )
                {
                    stack.push({ term: t.delayed, dbn })
                    continue;
                }
                if( t instanceof IRForced )
                {
                    stack.push({ term: t.forced, dbn });
                    continue;
                }
                if( t instanceof IRFunc )
                {
                    stack.push({ term: t.body, dbn: dbn + t.arity });
                    continue;
                }
                // no hoisted
            }
        }

        // save parent so when replacing we don't create a circular sameLettedRefs
        const parent = parentNode;

        const newNode = new IRApp(
            new IRFunc(
                1,
                parentNodeDirectChild
            ),
            lettedValue
        );

        _modifyChildFromTo(
            parent,
            parentNodeDirectChild, // not really used since we know parent is not `IRApp`
            newNode
        );

        sameLettedRefs = findAllNoHoisted(
            parentNodeDirectChild,
            term => 
                term instanceof IRLetted &&
                (
                    sameLettedRefs.includes( term ) ||
                    sameLettedRefs.some(({ hash }) => uint8ArrayEq( hash, setLettedHash ) )
                )
        ) as IRLetted[];

        for( const ref of sameLettedRefs )
        {
            // console.log( "isChildOf( ref, parentNodeDirectChild )", isChildOf( ref, parentNodeDirectChild ) );
            // console.log( "hasChild( parentNodeDirectChild , ref )", hasChild( parentNodeDirectChild , ref ) );
            // console.log( "isChildOf( ref, maxScope )", isChildOf( ref, maxScope ) );
            // console.log( "hasChild( maxScope , ref )", hasChild( maxScope , ref ) );
            // console.log( "isChildOf( ref, newNode )", isChildOf( ref, newNode ) );
            // console.log( "hasChild( newNode , ref )", hasChild( newNode , ref ) );
            if( isChildOf( ref, parentNodeDirectChild ) )
            {
                _modifyChildFromTo(
                    ref.parent,
                    ref,
                    new IRVar( getDebruijnInTerm( parentNodeDirectChild, ref ) )
                );
            }
        }
    }
}

function remove<T>( array: T[], shouldRemove: (elem: T, i: number) => boolean ): void
{
    for( let i = 0; i < array.length; i++ )
    {
        if( shouldRemove( array[i], i ) )
        {
            array.splice( i, 1 );
        }
    }
}

function removeFirst<T>( array: T[], shouldRemove: (elem: T, i: number) => boolean ): void
{
    for( let i = 0; i < array.length; i++ )
    {
        if( shouldRemove( array[i], i ) )
        {
            array.splice( i, 1 );
            break;
        }
    }
}

function removeIdx( array: any[], idx: number ): void
{
    array.slice( idx, 1 );
}

function filterWithIndex<T>( array: T[], predicate: ( elem: T, i: number ) => boolean ): { elem: T, i: number }[]
{
    return array.map((elem, i) => ({ elem, i })).filter(({ elem, i }) => predicate( elem, i ));
}

function isChildOf( child: IRTerm | undefined, parent: IRTerm ): boolean
{
    do
    {
        if( !child ) return false;
        if( child === parent ) return true;
    } while( child = child?.parent );

    return false;
}

function hasChild( parent: IRTerm, child: IRTerm ): boolean
{
    if( child === parent ) return true;
    if( parent instanceof IRApp ) return hasChild( parent.fn, child ) || hasChild( parent.arg, child );
    if( parent instanceof IRDelayed ) return hasChild( parent.delayed, child );
    if( parent instanceof IRForced )  return hasChild( parent.forced, child );
    if( parent instanceof IRFunc )  return hasChild( parent.body, child );
    if( parent instanceof IRLetted )  return hasChild( parent.value, child );
    if( parent instanceof IRHoisted )  return hasChild( parent.hoisted, child );

    return false;
}

/**
 * 
 * @param letted 
 * @returns {IRFunc} the lowest `IRFunc` in the tree that defines all the variables needed for the 
 */
function findLettedMaxScope( letted: IRLetted ): IRFunc
{
    let minUnboundDbn = _getMinUnboundDbn( letted.value );
    if( minUnboundDbn === undefined )
    {
        let tmp: IRTerm = letted;
        let maxScope: IRFunc | undefined = undefined;
        while( tmp.parent )
        {
            tmp = tmp.parent
            if( tmp instanceof IRFunc ) maxScope = tmp;
        };
        if( !maxScope ) throw new Error(
            `could not find a max scope for letted value with hash ${toHex(letted.hash)}`
        );
        return maxScope;
    }

    let tmp: IRTerm = letted;
    let maxScope: IRFunc | undefined = undefined;

    while( minUnboundDbn >= 0 )
    {
        if( !tmp.parent )
        {
            throw new Error(
                `could not find a max scope for letted value with hash ${toHex(letted.hash)}; `+
                `the max parent found leaves the term open (reached root)`
            );
        }
        tmp = tmp.parent;
        if( tmp instanceof IRFunc )
        {
            minUnboundDbn -= tmp.arity;
            maxScope = tmp;
        }
    }

    // just ts sillyness here
    if( !maxScope )
    {
        throw new Error(
            `could not find a max scope for letted value with hash ${toHex(letted.hash)}; `+
            `no IRFunc found`
        );
    }

    return maxScope;

}