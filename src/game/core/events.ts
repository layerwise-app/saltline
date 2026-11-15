/** A tiny synchronous publish/subscribe bus shared by all subsystems (`game.events`). */

/** Callback receiving an event's payload. */
export type EventHandler<P = unknown> = (payload: P) => void;

/** Named-event bus. Handler exceptions are logged and never stop other handlers. */
export interface EventBus {
  /** Subscribes to `event`; returns a function that unsubscribes. */
  on<P = unknown>(event: string, handler: EventHandler<P>): () => void;
  off<P = unknown>(event: string, handler: EventHandler<P>): void;
  emit<P = unknown>(event: string, payload?: P): void;
}

/** Creates an empty event bus. */
export function createEventBus(): EventBus {
  const handlersByEvent = new Map<string, EventHandler[]>();
  return {
    on(event, handler) {
      if (!handlersByEvent.has(event)) handlersByEvent.set(event, []);
      handlersByEvent.get(event)!.push(handler as EventHandler);
      return () => this.off(event, handler);
    },
    off(event, handler) {
      const handlers = handlersByEvent.get(event);
      if (handlers) {
        const index = handlers.indexOf(handler as EventHandler);
        if (index >= 0) handlers.splice(index, 1);
      }
    },
    emit(event, payload) {
      const handlers = handlersByEvent.get(event);
      if (handlers)
        for (let i = 0; i < handlers.length; i++)
          try {
            handlers[i](payload);
          } catch (error) {
            console.error(`[events] handler for "${event}" threw`, error);
          }
    }
  };
}
