export interface ConfigInterface {
    listener: ({
        shortName: string,
        loginData: any,
        id: number
    })[],
    databases: ({
        shortName: string,
        params: any,
        id: number,
        name: string
    })[],
    defaultDatabase: number,
    moduleConfig: {
        [shortName: string]: any
    }
}
