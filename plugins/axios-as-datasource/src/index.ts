import { GSContext, GSDataSource, GSStatus, PlainObject } from "@godspeedsystems/core";
import axios, { AxiosInstance, AxiosResponse } from 'axios'
export default class DataSource extends GSDataSource {
  rand = Math.random();
  isSecondHit: boolean = false;
  tokenRefreshPromise: Promise<any> | null = null;
  refreshCount = 0;
  refreshingCount = 0;
  waitAndHitCount = 0;
  successCount = 0;
  attemptsCount = 0;
  protected async initClient(): Promise<PlainObject> {
    const { base_url, timeout, headers, authn } = this.config;
    //For token refresh logic, if authn key is present, configure the refresh logic
    if (authn) {
      //Set status codes to refresh on, if customLogic for refresh check is not set
      if (!authn.refreshOn?.customLogic) {
        //set the status code to refresh on
        let defaultCodes = authn.refreshOn?.statusCode;
        authn.refreshOn = authn.refreshOn || {};
        if (!defaultCodes) {
          authn.refreshOn.statusCode = [401];
        } else if (Array.isArray(defaultCodes) && defaultCodes.length === 0) {
          authn.refreshOn.statusCode = [401]
        } else if (typeof defaultCodes === 'number') {
          authn.refreshOn.statusCode = [defaultCodes];
        }
      }
      //initialize the authentication function
      const fnPath = this.config.authn.fn.replaceAll('\.', '/');
      this.config.authn.fn = require(`${process.cwd()}/dist/functions/${fnPath}`);

    }
    const client = axios.create({ baseURL: base_url, timeout, headers });

    if (this.config.curlifiedLogs) {
      const curlirize = require('../curlize');
      curlirize(client);
    }
    //initialize token headers
    await this.setAuthHeaders();
    return client;
  };

  async execute(ctx: GSContext, args: PlainObject, retryCount = 0): Promise<any> {
    ++this.attemptsCount;
    const baseURL = this.config.base_url;
    let {
      meta: { fnNameInWorkflow },
      headers,
      ...rest //the remaining arguments of the axios call
    } = args;

    const [, , method, url] = fnNameInWorkflow.split('.');

    try {
      if (this.tokenRefreshPromise) {
        ++this.waitAndHitCount;
        await this.tokenRefreshPromise;
      }
      
      const client = this.client as AxiosInstance;

      //Hit the API with headers
      // ctx.childLogger.error('headers first %o %o', Object.keys(headers), Object.keys(this.config.headers))

      headers = headers ? Object.assign({}, this.config.headers, headers) : this.config.headers;
      // ctx.childLogger.error('headers %o', Object.keys(headers))
      const query = {
        method: method.toLowerCase(),
        url,
        baseURL,
        headers,
        ...rest
      };
      //For testing auth refresh in concurrenct scenarios
      // if (!this.isSecondHit) {
      //   this.isSecondHit = true;
      //   delete this.config.headers['X-COREOS-ACCESS'];
      //   delete this.config.headers['X-COREOS-ORIGIN-TOKEN'];
      //   ctx.childLogger.error('unset')
      // };
      
      let response = await client(query);
      ++this.successCount;
      return new GSStatus(true, response.status, response.statusText, response.data, response.headers);
    } catch (error: any) {
      let { response } = error;
      ctx.childLogger.fatal('attempts %s success %s waitAndHit %s refresh %s refreshing %s', this.attemptsCount, this.successCount, this.waitAndHitCount, this.refreshCount, this.refreshingCount);

      if (!response) {
        //Some random error occured. Not axios error.
        return new GSStatus(false, 503, error.message, { error });
      }
      // axios request failed

      if (!this.config.authn) {
        const { status, data: { message }, headers } = response as AxiosResponse;
        return new GSStatus(false, status, message, response.data, headers);
      }

      //This instance of axios DS has authn enabled for the API
      //Check if this is an authentication error. Handle both cases.

      let authFailed: boolean = this.isAuthFailed(response);
      //If auth failed we need to refresh the token (if process not already initiated) 
      //and wait while it is being refreshed
      if (authFailed) {
        if (!this.tokenRefreshPromise) {
          ++this.refreshCount
          this.startTokenRefresh(ctx);
          //Wait for auth token(s) to be refreshed
          try {
            await this.tokenRefreshPromise;
          } catch (err) {
            return new GSStatus(false, 500, error.message, 'Internal Server Error');
          }
        } else {
          ++this.refreshingCount;
          //Wait for auth token(s) to be refreshed
          try {
            await this.tokenRefreshPromise;
          } catch (err) {
            return new GSStatus(false, 500, error.message, 'Internal Server Error');
          }
        }

        //Try the API call again now
        return await this.execute(ctx, args);
      } else {
        ++this.successCount;
        //This is a non-auth axios error
        const { status, data: { message }, headers } = response as AxiosResponse;
        return new GSStatus(false, status, message, response.data, headers);
      }

    }
  }
  isAuthFailed(response: AxiosResponse) {
    const authn = this.config.authn;

    const tokenRefreshFn = authn.refreshOn.customLogic;
    //If token refresh function is present, we will use that instead of status code check
    if (tokenRefreshFn) {
      if (tokenRefreshFn(response) === true) {
        return true;
      }
    } else { //check status code of response
      const statusCodes: number[] = authn.refreshOn.statusCode;
      if (statusCodes.includes(response.status)) {
        return true;
      }
    }
    return false;
  }
  startTokenRefresh(ctx: GSContext) {
    const that = this;
    //Inititialize this promise so that other concurrent requests dont start refreshing the token in parallel
    this.tokenRefreshPromise = new Promise(async (resolve, reject) => {
      //Get and set new access headers
      try {
        await that.setAuthHeaders(ctx);
        //set this to null so that next request can directly be executed with newly set auth headers
        that.tokenRefreshPromise = null;
        //resolve this promise so that those waiting can continue further
        resolve(null);
      } catch (err) {
        reject(err);
      }
    });
  }
  async setAuthHeaders(ctx?: GSContext) {
    const authnHeaders: PlainObject = await this.config.authn.fn(ctx);
    Object.assign(this.config.headers, authnHeaders);
  }
}


const SourceType = 'DS';
const Type = 'axios'; // this is the loader file of the plugin, So the final loader file will be `types/${Type.js}`
const CONFIG_FILE_NAME = 'api'; // in case of event source, this also works as event identifier, and in case of datasource works as datasource name
const DEFAULT_CONFIG = {};

export {
  DataSource,
  SourceType,
  Type,
  CONFIG_FILE_NAME,
  DEFAULT_CONFIG
}