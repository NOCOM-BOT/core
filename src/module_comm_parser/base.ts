import EventEmitter from "node:events";

export default abstract class ModuleCommParser extends EventEmitter {
    abstract killed: boolean;
    
    abstract send(data: any): void;
    abstract kill(): void;
}