import type { Message, Model } from "@earendil-works/pi-ai";

/** In-process, one-use token carried only between the durable preflight hook and
 * the model boundary. The marker is stripped before the provider sees context.
 * A swallowed/reported hook error cannot accidentally start a model request. */
export class RequestMarkerGate {
  readonly #issued = new WeakMap<object, string>();

  mark(messages: readonly Message[], model: Model<string>): { readonly messages: readonly Message[] } {
    const marker: Message = { role: "system", content: "", timestamp: Date.now() };
    this.#issued.set(marker, `${model.provider}/${model.id}`);
    return { messages: [...messages, marker] };
  }

  claim<T extends { messages: Message[] }>(context: T, model: Model<string>): T {
    const marker = context.messages.at(-1);
    const key = marker && this.#issued.get(marker);
    if (!marker || !key || key !== `${model.provider}/${model.id}`) throw Error("Model request has no admitted durable budget token");
    this.#issued.delete(marker);
    return { ...context, messages: context.messages.slice(0, -1) };
  }
}
