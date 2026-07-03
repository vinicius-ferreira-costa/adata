/**
 * content.js — roda no mundo ISOLADO da extensão (padrão do MV3).
 *
 * Papel: ponte entre a página e o service worker. O interceptor.js (contexto
 * da página) não tem acesso a chrome.runtime; este script tem, mas não
 * enxerga o fetch da página. A comunicação entre os dois mundos é feita por
 * window.postMessage.
 */
(() => {
  "use strict";

  const FONTE_ESPERADA = "ADATA_INTERCEPTOR";

  window.addEventListener("message", (event) => {
    // Validações anti-spoofing: qualquer script da página (ou de um iframe)
    // pode chamar window.postMessage. Só aceitamos mensagens:
    //  1. vindas desta MESMA janela (event.source === window), o que exclui
    //     iframes e janelas externas;
    //  2. com o identificador do nosso interceptor.
    if (event.source !== window) return;
    if (!event.data || event.data.source !== FONTE_ESPERADA) return;

    try {
      chrome.runtime.sendMessage(
        {
          type: "ADATA_PAYLOAD",
          url: event.data.url,
          payload: event.data.payload,
          // "passiva" (Adalove pediu — aluno olhando a turma) ou "ativa"
          // (varredura de fundo). O background só move a turma ativa na 1ª.
          origem: event.data.origem === "ativa" ? "ativa" : "passiva",
        },
        () => {
          // Ler lastError evita o warning "Unchecked runtime.lastError" quando
          // o service worker está dormindo/reiniciando. A mensagem em si já
          // acorda o worker, então não precisamos de retry.
          void chrome.runtime.lastError;
        }
      );
    } catch (erro) {
      // "Extension context invalidated" acontece quando a extensão é
      // recarregada com a aba aberta. Não há o que fazer além de não quebrar.
      console.debug("[Adata] Contexto da extensão indisponível:", erro);
    }
  });
})();
