import NCBCore from ".";

export default class NCBCoreModule {
    core: NCBCore;

    constructor(core: NCBCore) {
        this.core = core;
    }

    stop() {};

    queueMessage(data: any) {
        
    }
}