import NCBCore from ".";
import NCBModule from "./module";

export default class NCBCoreModule {
    eventTable: {
        [eventName: string]: {
            module: NCBModule,
            api: string
        }[]
    } = {}

    core: NCBCore;
    moduleID: string = "core";
    displayName = "NOCOM_BOT Core";

    constructor(core: NCBCore) {
        this.core = core;
    }

    stop() { };

    queueMessage(data: any) {
        (async () => {
            if (
                typeof data === "object" &&
                data.type === "api_call"
            ) {
                // Core module will only handle API call,
                // anything else will be ignored.

                let senderModule = this.core.module[data.call_from] as any as NCBModule;
                let returnData = null;

                switch (data.call_cmd) {
                    case "get_registered_modules":
                        returnData = Object.entries(
                            this.core.module
                        ).map(([moduleID, module]) => ({
                            moduleID,
                            shortname: module.moduleID,
                            displayname: module.displayName
                        }));
                        break;

                    case "kill":
                        senderModule.stop();
                        break;

                    case "shutdown_core":
                        this.core.stop();
                        break;

                    case "restart_core":
                        await this.core.stop();
                        await this.core.start();
                        return;

                    case "register_event_hook":
                        if (!Array.isArray(this.eventTable[data.eventName])) {
                            this.eventTable[data.eventName] = [];
                        }

                        this.eventTable[data.eventName].push({
                            module: senderModule,
                            api: data.callbackFunction
                        });

                        returnData = { success: true };

                    case "unregister_event_hook":
                        if (!Array.isArray(this.eventTable[data.eventName])) {
                            this.eventTable[data.eventName] = [];
                            returnData = { success: false };
                        } else {
                            let index = this.eventTable[data.eventName].findIndex(v => v.module === senderModule && v.api === data.callbackFunction);
                            if (index + 1) {
                                this.eventTable[data.eventName].splice(index, 1);

                                returnData = { success: true };
                            } else {
                                returnData = { success: false };
                            }
                        }
                        break;

                    case "send_event":
                        if (!Array.isArray(this.eventTable[data.eventName])) {
                            this.eventTable[data.eventName] = [];
                            returnData = { hasSubscribers: false };
                        } else {
                            if (this.eventTable[data.eventName].length) {
                                for (let subscriber of this.eventTable[data.eventName]) {
                                    subscriber.module.queueMessage({
                                        type: "api_call",
                                        call_from: "core",
                                        call_cmd: subscriber.api,
                                        data: {
                                            calledFrom: senderModule.moduleID,
                                            eventName: data.eventName,
                                            eventData: data.data
                                        },
                                        nonce: -1
                                    });
                                }

                                returnData = { hasSubscribers: true };
                            } else {
                                returnData = { hasSubscribers: false };
                            }
                        }
                }
            }
        })();
    }
}
