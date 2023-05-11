import type NCBCore from ".";
import NCBModule from "./module";

import { loadDependencies, loadSpecificDependencies } from "./pnpm.js";

import path from "node:path";
import fsSync from "node:fs";

export default class NCBCoreModule {
    apiCallbackTable: {
        [nonce: string]: (data: any) => void
    } = {};

    _eventTable: {
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

    async stop() { };

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
                                    type: module.module,
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
                                await this.core.stop(true);
                                await new Promise(resolve => setTimeout(resolve, 1000)); // intentional delay
                                await this.core.start();
                                return;

                            // 4.5
                            case "register_event_hook":
                                if (!Array.isArray(this._eventTable[data.data.eventName])) {
                                    this._eventTable[data.data.eventName] = [];
                                }

                                this._eventTable[data.data.eventName].push({
                                    module: senderModule,
                                    api: data.data.callbackFunction
                                });
                                returnData = { success: true };

                            // 4.6
                            case "unregister_event_hook":
                                if (!Array.isArray(this._eventTable[data.data.eventName])) {
                                    this._eventTable[data.data.eventName] = [];
                                    returnData = { success: false };
                                } else {
                                    let index = this._eventTable[data.data.eventName].findIndex(v => v.module === senderModule && v.api === data.callbackFunction);
                                    if (index + 1) {
                                        this._eventTable[data.data.eventName].splice(index, 1);

                                        returnData = { success: true };
                                    } else {
                                        returnData = { success: false };
                                    }
                                }
                                break;

                            // 4.7
                            case "send_event":
                                if (!Array.isArray(this._eventTable[data.data.eventName])) {
                                    this._eventTable[data.data.eventName] = [];
                                    returnData = { hasSubscribers: false };
                                } else {
                                    if (this._eventTable[data.data.eventName].length) {
                                        for (let subscriber of this._eventTable[data.data.eventName]) {
                                            subscriber.module.queueMessage({
                                                type: "api_call",
                                                call_from: "core",
                                                call_cmd: subscriber.api,
                                                data: {
                                                    calledFrom: senderModule.moduleID,
                                                    eventName: data.data.eventName,
                                                    eventData: data.data.data
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
                                    typeof data.data.pluginName === "string" &&
                                    typeof data.data.namespace === "string" &&
                                    typeof data.data.version === "string" &&
                                    typeof data.data.author === "string" &&
                                    data.data.namespace
                                ) {
                                    if (this.core.tempData.plReg[data.data.namespace]) {
                                        returnData = { conflict: true };
                                    } else {
                                        this.core.tempData.plReg[data.data.namespace] = {
                                            pluginName: data.data.pluginName,
                                            version: data.data.version,
                                            author: data.data.author,
                                            resolver: senderModule.moduleID
                                        };
                                        this.core.logger.info("core", `Plugin namespace "${data.data.namespace}" registered by module ID ${senderModule.moduleID}`);
                                        returnData = { conflict: false };
                                    }
                                } else {
                                    throw "Invalid input";
                                }
                                break;

                            // 4.9
                            case "unregister_plugin":
                                if (typeof data.data.namespace === "string" && data.data.namespace) {
                                    returnData = { success: !!this.core.tempData.plReg[data.data.namespace] };
                                    delete this.core.tempData.plReg[data.data.namespace];
                                    this.core.logger.info("core", `Plugin namespace "${data.data.namespace}" unregistered by module ID ${senderModule.moduleID}`);
                                } else {
                                    returnData = { success: false };
                                }
                                break;

                            // 4.10
                            case "prompt":
                                {
                                    let typedDataPrompt = data.data as {
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
                                    let typedDataLog = data.data as {
                                        level: "critical" | "error" | "warn" | "info" | "debug" | "verbose",
                                        data: any[],
                                        namespace: string
                                    }
                                    this.core.logger[typedDataLog.level]?.(typedDataLog.namespace, ...typedDataLog.data);
                                }
                                break;

                            // 4.12
                            case "wait_for_module":
                                {
                                    if (Object.entries(this.core.module).find(([, module]) => (module.namespace === data.data.moduleNamespace && module.started))) {
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
                                            if (plLoadEv.namespace === data.data.moduleNamespace) {
                                                // Loaded.
                                                this.core.signalChannel.removeListener("plugin_load", funcCallback);
                                                try {
                                                    clearTimeout(timeout);
                                                } catch { }
                                                wfmCallback(true);
                                            }
                                        }

                                        this.core.signalChannel.on("plugin_load", funcCallback);
                                        if (typeof data.data.timeout === "number") {
                                            timeout = setTimeout(() => {
                                                this.core.signalChannel.removeListener("plugin_load", funcCallback);
                                                wfmCallback(false);
                                            }, data.data.timeout);
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

                            // 4.15
                            case "pnpm_install":
                                {
                                    let typedDataPnpmInstall = data.data as {
                                        path: string
                                    }

                                    if (typedDataPnpmInstall.path) {
                                        if (fsSync.existsSync(typedDataPnpmInstall.path)) {
                                            try {
                                                loadDependencies(typedDataPnpmInstall.path);
                                                returnData = { success: true };
                                            } catch (e) {
                                                returnData = { success: false, error: String(e) };
                                            }
                                        } else {
                                            returnData = {
                                                success: false,
                                                error: "Path does not exist"
                                            }
                                        }
                                    }
                                }
                                break;

                            // 4.16:
                            case "pnpm_install_specific":
                                {
                                    let typedDataPnpmInstall = data.data as {
                                        path: string,
                                        dep: string
                                    }

                                    if (typedDataPnpmInstall.path) {
                                        if (fsSync.existsSync(typedDataPnpmInstall.path)) {
                                            try {
                                                loadSpecificDependencies(typedDataPnpmInstall.path, typedDataPnpmInstall.dep);
                                                returnData = { success: true };
                                            } catch (e) {
                                                returnData = { success: false, error: String(e) };
                                            }
                                        } else {
                                            returnData = {
                                                success: false,
                                                error: "Path does not exist"
                                            }
                                        }
                                    }
                                }
                                break;

                            // 4.17
                            case "get_plugin_namespace_info":
                                {
                                    let typedDataGetNamespaceInfo = data.data as {
                                        namespace: string
                                    }

                                    if (typedDataGetNamespaceInfo.namespace) {
                                        if (this.core.tempData.plReg[typedDataGetNamespaceInfo.namespace]) {
                                            returnData = {
                                                exist: true,
                                                pluginName: this.core.tempData.plReg[typedDataGetNamespaceInfo.namespace].pluginName,
                                                version: this.core.tempData.plReg[typedDataGetNamespaceInfo.namespace].version,
                                                author: this.core.tempData.plReg[typedDataGetNamespaceInfo.namespace].author,
                                                resolver: this.core.tempData.plReg[typedDataGetNamespaceInfo.namespace].resolver
                                            }
                                        }
                                    } else {
                                        returnData = { exist: false };
                                    }
                                }
                                break;

                            // 4.18
                            case "get_default_db":
                                {
                                    returnData = {
                                        databaseID: this.core.tempData.defaultDatabase,
                                        resolver: this.core.tempData.databases.get(this.core.tempData.defaultDatabase)
                                    };
                                }
                                break;

                            // 4.19
                            case "get_db_resolver":
                                {
                                    let typedData = data.data as {
                                        databaseID: number
                                    }

                                    if (typedData.databaseID) {
                                        if (this.core.tempData.databases.has(typedData.databaseID)) {
                                            returnData = {
                                                resolver: this.core.tempData.databases.get(typedData.databaseID)
                                            };
                                        } else {
                                            throw "Database does not exist";
                                        }
                                    } else {
                                        throw "No database ID specified";
                                    }
                                }
                                break;
                            
                            // 4.20
                            case "get_persistent_data":
                                {
                                    returnData = this.core.tempData.persistentData.get(senderModule);
                                }
                                break;

                            // 4.21
                            case "set_persistent_data":
                                {
                                    let setD = data.data;
                                    this.core.tempData.persistentData.set(senderModule, setD);

                                    returnData = true;
                                }
                                break;

                            // 4.22
                            case "get_operator_list":
                                {
                                    returnData = this.core.config.operators;
                                }
                                break;

                            // 4.23
                            case "wait_for_default_db":
                                {
                                    await this.core.tempData.defaultDBPromise;
                                    returnData = null;
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
        let resolve = (value: ({
            exist: true,
            data: any,
            error: any
        } | { exist: false })) => { }, promise = new Promise<({
            exist: true,
            data: any,
            error: any
        } | { exist: false })>(r => resolve = r);
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
