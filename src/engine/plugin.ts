import {
  Message,
  PluginProfile,
  Api,
  ApiEventEmitter,
  PluginRequest,
  ExtractKey,
  PluginApi,
} from '../types'
import { EventEmitter } from 'events'

type MessageListener = ['message', (e: MessageEvent) => void, false]

export class Plugin<T extends Api> implements PluginApi<T> {
  // Listener is needed to remove the listener
  private readonly listener: MessageListener = ['message', e => this.getMessage(e), false]
  private id = 0
  private iframe: HTMLIFrameElement
  private origin: string
  private source: Window
  // Request to the plugin waiting in queue
  private requestQueue: Array<() => Promise<any>> = []
  // Request from outside to the plugin waiting for response from the plugin
  private pendingRequest: {
    [name: string]: {
      [id: number]: (payload: any) => void
    }
  } = {}

  public readonly name: T['name']
  public events = new EventEmitter() as ApiEventEmitter<T>
  public notifs = {}
  public request: (value: { name: string; key: string; payload: any }) => Promise<any>

  constructor(public profile: PluginProfile<T>) {
    this.name = profile.name

    const notifs = profile.notifications || {}
    for (const name in notifs) {
      this.notifs[name] = {}
      const keys = notifs[name] || []
      keys.forEach(key => {
        this.notifs[name][key] = (payload: any[]) => {
          this.postMessage({ action: 'notification', name, key, payload })
        }
      })
    }
  }

  /** Get message from the iframe */
  private async getMessage(event: MessageEvent) {
    if (event.origin !== this.origin) return // Filter only messages that comes from this origin
    const message: Message =
      typeof event.data === 'string' ? JSON.parse(event.data) : event.data
    switch (message.action) {
      case 'notification': {
        if (!message.payload) break
        this.events.emit(message.key, message.payload)
        break
      }
      case 'request': {
        const action = 'response'
        try {
          const payload = await this.request(message)
          const error = undefined
          this.postMessage({ ...message, action, payload, error })
        } catch (err) {
          const payload = undefined
          const error = err.message
          this.postMessage({ ...message, action, payload, error })
        }
        break
      }
      case 'response': {
        const { name, id, payload } = message
        this.pendingRequest[name][id](payload)
        delete this.pendingRequest[name][id]
        break
      }
      default: {
        throw new Error('Message should be a notification, request or response')
      }
    }
  }

  /**
   * Post a message to the iframe of this plugin
   * @param message The message to post
   */
  private postMessage(message: Partial<Message>) {
    if (!this.source) {
      throw new Error('No window attached to Iframe yet')
    }
    this.source.postMessage(message, this.origin)
  }

  /**
   * Add a request for the plugin to the queue and execute it in time
   * @param requestInfo Information concerning the incoming request
   * @param method The name of the method to call
   * @param payload The arguments of this method
   */
  public addRequest(
    requestInfo: PluginRequest,
    method: ExtractKey<T, Function>,
    payload: any[],
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.profile.methods || !this.profile.methods.includes(method)) {
        reject(new Error(`Method ${method} is not exposed by ${this.profile.name}`))
      }
      // Add the current request into the queue
      this.requestQueue.push(async () => {
        this.id++
        this.postMessage({
          action: 'request',
          name: this.name,
          key: method as string,
          id: this.id,
          payload,
          requestInfo,
        })
        // Wait for the response from the plugin
        this.pendingRequest[this.name][this.id] = (result: any) => {
          resolve(result)
          // Remove current request and call next
          this.requestQueue.shift()
          if (this.requestQueue.length !== 0) this.requestQueue[0]()
        }
      })
      // If there is only one request waiting, call it
      if (this.requestQueue.length === 1) {
        this.requestQueue[0]()
      }
    })
  }

  /**
   * Create and return the iframe
   */
  public render() {
    if (this.iframe) {
      throw new Error(`${this.name} plugin is already rendered`)
    }
    this.iframe = document.createElement('iframe')
    this.iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin')
    this.iframe.setAttribute('seamless', 'true')
    this.iframe.src = this.profile.url
    // Wait for the iframe to load and handshake
    this.iframe.onload = () => {
      window.addEventListener(...this.listener)
      this.origin = new URL(this.iframe.src).origin
      this.source = this.iframe.contentWindow
      this.postMessage({
        action: 'request',
        name: this.name,
        key: 'handshake',
      })
    }
    return this.iframe
  }

  public deactivate() {
    this.iframe.remove()
    this.iframe = null
    window.removeEventListener(...this.listener)
  }

}
