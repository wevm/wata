if (typeof globalThis.Event !== 'function') {
  const Event = function Event(type: string, init?: EventInit | undefined): Event {
    const event = Object.create((new.target ?? Event).prototype)
    Object.defineProperties(event, {
      bubbles: {
        configurable: true,
        enumerable: true,
        value: init?.bubbles ?? false,
      },
      cancelable: {
        configurable: true,
        enumerable: true,
        value: init?.cancelable ?? false,
      },
      composed: {
        configurable: true,
        enumerable: true,
        value: init?.composed ?? false,
      },
      currentTarget: {
        configurable: true,
        enumerable: true,
        value: null,
      },
      defaultPrevented: {
        configurable: true,
        enumerable: true,
        value: false,
      },
      eventPhase: {
        configurable: true,
        enumerable: true,
        value: 0,
      },
      isTrusted: {
        configurable: true,
        enumerable: true,
        value: false,
      },
      target: {
        configurable: true,
        enumerable: true,
        value: null,
      },
      timeStamp: {
        configurable: true,
        enumerable: true,
        value: Date.now(),
      },
      type: {
        configurable: true,
        enumerable: true,
        value: type,
      },
    })
    return event as Event
  }
  Event.prototype = Object.create(Object.prototype)
  Object.defineProperties(Event.prototype, {
    composedPath: {
      configurable: true,
      value: function composedPath() {
        return []
      },
      writable: true,
    },
    constructor: {
      configurable: true,
      value: Event,
      writable: true,
    },
    preventDefault: {
      configurable: true,
      value: function preventDefault(this: Event) {
        if (!this.cancelable) return
        Object.defineProperty(this, 'defaultPrevented', {
          configurable: true,
          enumerable: true,
          value: true,
        })
      },
      writable: true,
    },
    stopImmediatePropagation: {
      configurable: true,
      value: function stopImmediatePropagation() {},
      writable: true,
    },
    stopPropagation: {
      configurable: true,
      value: function stopPropagation() {},
      writable: true,
    },
  })
  Object.defineProperty(globalThis, 'Event', {
    configurable: true,
    value: Event,
    writable: true,
  })
}

if (typeof globalThis.MessageEvent !== 'function') {
  const MessageEvent = function MessageEvent<payload = unknown>(
    type: string,
    init?: MessageEventInit<payload> | undefined,
  ): MessageEvent<payload> {
    const event = Reflect.construct(Event, [type, init], new.target ?? MessageEvent)
    Object.defineProperties(event, {
      data: {
        configurable: true,
        enumerable: true,
        value: init?.data,
      },
      lastEventId: {
        configurable: true,
        enumerable: true,
        value: init?.lastEventId ?? '',
      },
      origin: {
        configurable: true,
        enumerable: true,
        value: init?.origin ?? '',
      },
      ports: {
        configurable: true,
        enumerable: true,
        value: init?.ports ?? [],
      },
      source: {
        configurable: true,
        enumerable: true,
        value: init?.source ?? null,
      },
    })
    return event as MessageEvent<payload>
  }
  MessageEvent.prototype = Object.create(Event.prototype)
  Object.defineProperty(MessageEvent.prototype, 'constructor', {
    configurable: true,
    value: MessageEvent,
  })
  Object.defineProperty(globalThis, 'MessageEvent', {
    configurable: true,
    value: MessageEvent,
    writable: true,
  })
}
