// Chattlogik för sajten. Pratar bara med vår egen server (/api/chat), aldrig direkt
// med Eneo, så ingen nyckel finns i webbläsaren. UI:t (Astryx Chat-komponenter) läser
// `messages`, `status` och anropar `send`.
import { useCallback, useRef, useState } from "react";

export type Source = { id: string; title: string; url: string | null };
export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  sources?: Source[];
  failed?: boolean;
};
type StreamEvent =
  | { type: "session"; id: string }
  | { type: "text"; text: string }
  | { type: "sources"; items: Source[] }
  | { type: "error"; message: string }
  | { type: "done" };

// Eneo märker källor i svaret som <inref id="abcd1234"/>. Gör om dem till [1], [2] …
// och dölj en tagg som ännu inte strömmat klart.
export function withCitations(text: string, sources: Source[] = []): string {
  return text
    .replace(/<inref id="([0-9a-f]{8})"\s*\/>/g, (_, id: string) => {
      const index = sources.findIndex((s) => s.id === id);
      return index === -1 ? "" : ` [${index + 1}]`;
    })
    .replace(/<inref[^>]*$/, "");
}

export function useEneoChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<"idle" | "streaming">("idle");
  const sessionId = useRef<string | null>(null);

  const update = (id: string, change: (m: ChatMessage) => ChatMessage) =>
    setMessages((all) => all.map((m) => (m.id === id ? change(m) : m)));

  const send = useCallback(async (question: string) => {
    const trimmed = question.trim();
    if (!trimmed || status === "streaming") return;
    const answerId = crypto.randomUUID();
    setMessages((all) => [
      ...all,
      { id: crypto.randomUUID(), role: "user", text: trimmed },
      { id: answerId, role: "assistant", text: "" },
    ]);
    setStatus("streaming");

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: trimmed, sessionId: sessionId.current }),
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message ?? "Något gick fel. Försök igen.");
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          if (!frame.startsWith("data: ")) continue;
          const event = JSON.parse(frame.slice(6)) as StreamEvent;
          if (event.type === "session") sessionId.current = event.id;
          if (event.type === "text") update(answerId, (m) => ({ ...m, text: m.text + event.text }));
          if (event.type === "sources") update(answerId, (m) => ({ ...m, sources: event.items }));
          if (event.type === "error") update(answerId, (m) => ({ ...m, failed: true, text: m.text || event.message }));
        }
      }
    } catch (error) {
      update(answerId, (m) => ({ ...m, failed: true, text: error instanceof Error ? error.message : "Något gick fel." }));
    } finally {
      setStatus("idle");
    }
  }, [status]);

  const reset = useCallback(() => {
    sessionId.current = null;
    setMessages([]);
  }, []);

  return { messages, status, send, reset };
}
