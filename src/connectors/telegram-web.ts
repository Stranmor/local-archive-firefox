import { defineArchiveConnector } from '@/src/shared/connector';

export const telegramWebConnector = defineArchiveConnector({
  id: 'telegram-web',
  displayName: 'Telegram',
  conversationLabel: 'chat',
  conversationsLabel: 'chats',
  surfaceLabel: 'this Telegram tab',
  launchUrl: 'https://web.telegram.org/k/',
  allowedOrigins: ['https://web.telegram.org'],
  entrypoint: '/telegram-exporter.js',
  capabilities: {
    currentConversation: true,
    multipleConversations: true,
    categories: true,
    media: true,
    historyTarget: true,
    history: {
      mode: 'native',
      fullConversation: true,
      dateRange: true,
      automatic: true,
      userVisibleScroll: false,
    },
  },
});
