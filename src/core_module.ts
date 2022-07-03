import type NCBCore from ".";
import NCBModule from "./module";

import path from "node:path";

export default class NCBCoreModule {
    apiCallbackTable: {
        [nonce: string]: (data: any) => void
    } = {};

    eventTable: {
        [eventName: string]: {
            module: NCBModule,
            api: string
        }[]
    } = {}

    core: NCBCore;
    moduleID: string = "core";
    displayName = "NOCOM_BOT Core";
    namespace = "core";
    module = "core";
    readonly starting = false;
    readonly started = true;

    constructor(core: NCBCore) {
        this.core = core;
    }

    stop() { };

    queueMessage(data: any) {
        (async () => {
            if (typeof data === "object") {
                if (data.type === "api_call") {
                    // Providing API for other modules

                    let senderModule = this.core.module[data.call_from] as any as NCBModule;
                    let returnData = null;
                    let exist = true;

                    try {
                        switch (data.call_cmd) {
                            // 4.1
                            case "get_registered_modules":
                                returnData = Object.entries(
                                    this.core.module
                                ).map(([moduleID, module]) => ({
                                    moduleID,
                                    namespace: module.namespace,
                                    displayname: module.displayName,
                                    running: module.started
                                }));
                                break;

                            // 4.2
                            case "kill":
                                senderModule.stop();
                                break;

                            // 4.3
                            case "shutdown_core":
                                this.core.stop();
                                break;

                            // 4.4
                            case "restart_core":
                                await this.core.stop();
                                await this.core.start();
                                return;

                            // 4.5
                            case "register_event_hook":
                                if (!Array.isArray(this.eventTable[data.eventName])) {
                                    this.eventTable[data.eventName] = [];
                                }

                                this.eventTable[data.eventName].push({
                                    module: senderModule,
                                    api: data.callbackFunction
                                });

                                returnData = { success: true };

                            // 4.6
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

                            // 4.7
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
                                break;

                            // 4.8
                            case "register_plugin":
                                if (
                                    typeof data.pluginName === "string" &&
                                    typeof data.namespace === "string" &&
                                    typeof data.version === "string" &&
                                    typeof data.author === "string" &&
                                    data.namespace
                                ) {
                                    if (this.core.tempData.plReg[data.namespace]) {
                                        returnData = { conflict: true };
                                    } else {
                                        this.core.tempData.plReg[data.namespace] = {
                                            pluginName: data.pluginName,
                                            version: data.version,
                                            author: data.author
                                        }
                                        returnData = { conflict: false };
                                    }
                                } else {
                                    throw "Invalid input";
                                }
                                break;

                            // 4.9
                            case "unregister_plugin":
                                if (typeof data.namespace === "string" && data.namespace) {
                                    returnData = { success: !!this.core.tempData.plReg[data.namespace] };
                                    delete this.core.tempData.plReg[data.namespace];
                                } else {
                                    returnData = { success: false };
                                }

                            // 4.10
                            case "prompt":
                                {
                                    let typedDataPrompt = data as {
                                        promptInfo: string,
                                        promptType: "string" | "yes-no",
                                        defaultValue?: string | boolean
                                    }
                                    let rtData = await this.core.promptChannel.prompt(typedDataPrompt.promptType, typedDataPrompt.promptInfo, typedDataPrompt.defaultValue);
                                    returnData = { data: rtData }
                                }
                                break;

                            // 4.11
                            case "log":
                                {
                                    let typedDataLog = data as {
                                        level: "critical" | "error" | "warn" | "info" | "debug",
                                        data: any[],
                                        namespace: string
                                    }
                                    this.core.logger[typedDataLog.level]?.(typedDataLog.namespace, ...typedDataLog.data);
                                }
                                break;

                            // 4.12
                            case "wait_for_module":
                                {
                                    if (Object.entries(this.core.module).find(([, module]) => (module.namespace === data.moduleNamespace && module.started))) {
                                        returnData = true;
                                    } else {
                                        let wfmCallback = (cb: boolean) => { },
                                            promise = new Promise<boolean>(r => wfmCallback = r),
                                            timeout: NodeJS.Timeout;

                                        // Now we wait.
                                        let funcCallback = (plLoadEv: {
                                            id: string,
                                            namespace: string
                                        }) => {
                                            if (plLoadEv.namespace === data.moduleNamespace) {
                                                // Loaded.
                                                this.core.signalChannel.removeListener("plugin_load", funcCallback);
                                                try {
                                                    clearTimeout(timeout);
                                                } catch { }
                                                wfmCallback(true);
                                            }
                                        }

                                        this.core.signalChannel.on("plugin_load", funcCallback);
                                        if (typeof data.timeout === "number") {
                                            timeout = setTimeout(() => {
                                                this.core.signalChannel.removeListener("plugin_load", funcCallback);
                                                wfmCallback(false);
                                            }, data.timeout);
                                        }

                                        returnData = await promise;
                                    }
                                }
                                break;

                            // 4.13
                            case "get_data_folder":
                                {
                                    returnData = path.join(this.core.profile_directory, "data");
                                }
                                break;

                            // 4.14
                            case "get_temp_folder":
                                {
                                    returnData = path.join(this.core.profile_directory, "temp", this.core.runInstanceID);
                                }
                                break;

                            default:
                                exist = false;
                        }

                        senderModule.queueMessage({
                            type: "api_response",
                            response_from: "core",
                            exist,
                            data: returnData,
                            error: null,
                            nonce: data.nonce
                        });
                    } catch (e) {
                        senderModule.queueMessage({
                            type: "api_response",
                            response_from: "core",
                            exist: true,
                            data: null,
                            error: String(e),
                            nonce: data.nonce
                        });
                    }
                } else if (data.type === "api_response") {
                    // Other code in the kernel can send API call on behalf of `core` module.
                    // This is the event listener to handle those API calls.
                    
                    if (this.apiCallbackTable[data.nonce]) {
                        this.apiCallbackTable[data.nonce]({
                            exist: data.exist,
                            data: data.data,
                            error: data.error
                        });
                        delete this.apiCallbackTable[data.response_from + data.nonce];
                    }
                }
            }
        })();
    }

    callAPI(targetModule: string, command: string, data: any) {
        let nonce = targetModule + "A" + Math.random().toString(10).substring(2);
        let resolve = (value: {
            exist: boolean,
            data: any,
            error: any
        }) => { }, promise = new Promise<{
            exist: boolean,
            data: any,
            error: any
        }>(r => resolve = r);
        this.apiCallbackTable[nonce] = resolve;

        this.core.module[targetModule].queueMessage({
            type: "api_call",
            call_from: "core",
            call_cmd: command,
            data: data,
            nonce
        });

        return promise;
    }
}
