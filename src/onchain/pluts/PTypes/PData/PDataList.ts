import { PData } from "./PData";
import { DataList } from "../../../../types/Data/DataList";
import { DataFromPData } from "../../lib/std/data/conversion";

export class PDataList<PDataInstance extends PData> extends PData // (PData extends PType => PDataList extends PType too)
{
    constructor( datas: DataFromPData<PDataInstance>[] = [] )
    {
        super( new DataList( datas ) );
    }
}