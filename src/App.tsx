import { useState } from 'react';
import { Layout, LayoutContent, VStack } from '@astryxdesign/core/Layout';
import { Heading, Text } from '@astryxdesign/core/Text';
import { ChatComposer, ChatMessage, ChatMessageBubble, ChatMessageList } from '@astryxdesign/core/Chat';
import { Markdown } from '@astryxdesign/core/Markdown';
import { useEneoChat, withCitations } from './lib/useEneoChat';

export default function App() {
  const { messages, status, send } = useEneoChat();
  const [draft, setDraft] = useState('');
  return (
    <Layout height="fill" contentWidth={720}
      content={
        <LayoutContent>
          <VStack gap={4}>
            <Heading level={1}>IT-säkerhetsguiden</Heading>
            <Text>Fråga om lösenord, nätfiske och säker hantering av information.</Text>
            <ChatMessageList isStreaming={status === 'streaming'}>
              {messages.map((m) => (
                <ChatMessage key={m.id} sender={m.role}>
                  <ChatMessageBubble>
                    {m.role === 'assistant'
                      ? <Markdown isStreaming={status === 'streaming'}>{withCitations(m.text, m.sources)}</Markdown>
                      : m.text}
                  </ChatMessageBubble>
                </ChatMessage>
              ))}
            </ChatMessageList>
            <ChatComposer value={draft} onChange={setDraft} placeholder="Skriv din fråga"
              onSubmit={(v) => { setDraft(''); void send(v); }} isDisabled={status === 'streaming'} />
          </VStack>
        </LayoutContent>
      }
    />
  );
}
