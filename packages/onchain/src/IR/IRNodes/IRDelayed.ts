import { Cloneable } from "@harmoniclabs/cbor/dist/utils/Cloneable";
import { blake2b_128 } from "@harmoniclabs/crypto";
import { BasePlutsError } from "../../utils/BasePlutsError";
import { ToJson } from "../../utils/ToJson";
import { IRTerm } from "../IRTerm";
import { IHash } from "../interfaces/IHash";
import { IIRParent } from "../interfaces/IIRParent";
import { concatUint8Arr } from "../utils/concatUint8Arr";
import { isIRTerm } from "../utils/isIRTerm";
import { IRParentTerm, isIRParentTerm } from "../utils/isIRParentTerm";

export class IRDelayed
    implements Cloneable<IRDelayed>, IHash, IIRParent, ToJson
{
    delayed!: IRTerm
    readonly hash!: Uint8Array
    markHashAsInvalid!: () => void;

    removeChild!: ( child: IRTerm ) => void;

    parent: IRParentTerm | undefined;

    constructor( delayed: IRTerm )
    {
        let hash: Uint8Array | undefined = undefined
        Object.defineProperty(
            this, "hash",
            {
                get: () => {
                    if(!(hash instanceof Uint8Array))
                    {
                        hash = blake2b_128(
                            concatUint8Arr(
                                IRDelayed.tag,
                                this.delayed.hash
                            )
                        );
                    }
                    return hash.slice();
                }
            }
        );

        Object.defineProperty(
            this, "markHashAsInvalid",
            {
                value: () => { 
                    hash = undefined;
                    this.parent?.markHashAsInvalid();
                },
                writable: false,
                enumerable:  false,
                configurable: false
            }
        );

        let _delayed: IRTerm;
        Object.defineProperty(
            this, "delayed",
            {
                get: () => _delayed,
                set: ( newDelayed: IRTerm | undefined ) => {
                    if(!isIRTerm( newDelayed ))
                    {
                        throw new BasePlutsError(
                            "invalid IRTerm to be delayed"
                        );
                    }
                    this.markHashAsInvalid();
                    if( _delayed )
                    {
                        _delayed.parent = undefined;
                    }
                    _delayed = newDelayed;
                    _delayed.parent = this;
                },
                enumerable: true,
                configurable: false
            }
        );
        this.delayed = delayed;

        let _parent: IRParentTerm | undefined = undefined;
        Object.defineProperty(
            this, "parent",
            {
                get: () => _parent,
                set: ( newParent: IRParentTerm | undefined ) => {

                    if(
                        (
                            newParent === undefined || 
                            isIRParentTerm( newParent )
                        ) &&
                        _parent !== newParent
                    )
                    {
                        _parent?.removeChild( this );
                        _parent = newParent;
                    }

                },
                enumerable: true,
                configurable: false
            }
        );
        
        Object.defineProperty(
            this, "removeChild",
            {
                value: ( child: any ) => {
                    if( _delayed === child ) _delayed = undefined as any;
                },
                writable: false,
                enumerable: false,
                configurable: false
            }
        );
    }

    static get tag(): Uint8Array
    {
        return new Uint8Array([0b0000_1001]);
    }

    clone(): IRDelayed
    {
        return new IRDelayed( this.delayed.clone() )
    }

    toJson(): any
    {
        return {
            type: "IRDelayed",
            delayed: this.delayed.toJson()
        }
    }
}