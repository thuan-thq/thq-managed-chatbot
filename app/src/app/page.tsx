import { ChatBlockPanel } from "@/components/chat-block-panel";
import { ChatWidgetEmbed } from "@/components/chat-widget-embed";

export default function Home() {
  return (
    <main>
      <ChatBlockPanel />
      <ChatWidgetEmbed />
    </main>
  );
}
