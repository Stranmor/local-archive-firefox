import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { installTelegramPageBridge } from '@/src/connectors/telegram-native-history';

// This unlisted script is injected into Telegram Web's page realm only after
// an explicit export action. Keeping a static bundle avoids string-eval while
// retaining the same postMessage contract as the scripting MAIN-world route.
export default defineUnlistedScript({
  main() {
    installTelegramPageBridge();
  },
});
