/**
 * interceptor.js — roda no contexto da PÁGINA (world: "MAIN" no manifest).
 *
 * Por quê no contexto da página e não no mundo isolado do content script?
 * O monkey-patch de window.fetch/XMLHttpRequest só enxerga as chamadas que a
 * própria aplicação Adalove faz se for aplicado no mesmo "mundo" JavaScript
 * em que a aplicação roda. No mundo isolado do content script, o window.fetch
 * é outra referência e a Adalove nunca passaria por ele.
 *
 * Por quê document_start? O patch precisa estar instalado ANTES do bundle da
 * Adalove executar, senão a aplicação captura a referência original de fetch
 * e as primeiras chamadas (justamente as que carregam os dados) escapam.
 *
 * Fluxo: página → (este arquivo) → window.postMessage → content.js →
 * chrome.runtime.sendMessage → background.js → chrome.storage.local.
 */
(() => {
  "use strict";

  // Só nos interessam as respostas da API de dados acadêmicos.
  const HOST_API = "apiv2.inteli.edu.br";

  // Identificador das mensagens deste interceptor. O content.js valida esse
  // campo para não aceitar postMessage de outras origens (anti-spoofing).
  const FONTE = "ADATA_INTERCEPTOR";

  /**
   * Envia um payload capturado para o content script.
   * targetOrigin fixo em window.location.origin: a mensagem nunca deve
   * vazar para frames de outras origens.
   *
   * origem distingue quem pediu os dados:
   *   "passiva" — a PRÓPRIA Adalove chamou a API (o aluno está olhando
   *               aquela turma agora) → o background usa isso para apontar
   *               a turma ativa do popup;
   *   "ativa"   — a nossa varredura de fundo (capturaAtiva) → só acumula
   *               dados, nunca mexe no ponteiro de turma ativa.
   */
  function repassar(url, payload, origem = "passiva") {
    try {
      window.postMessage(
        { source: FONTE, url: String(url), payload, origem },
        window.location.origin
      );
    } catch (erro) {
      // Payload não serializável ou frame em estado estranho: nunca deixamos
      // um erro nosso quebrar a página. Captura é "best effort".
      console.warn("[Adata] Falha ao repassar payload:", erro);
    }
  }

  function urlInteressa(url) {
    return typeof url === "string" && url.includes(HOST_API);
  }

  // ---------------------------------------------------------------------
  // fetch
  // ---------------------------------------------------------------------

  // Guardamos a referência ORIGINAL antes de sobrescrever. Sem isso, a nossa
  // versão chamaria a si mesma (recursão infinita) e o fetch real da página
  // se perderia para sempre.
  const fetchOriginal = window.fetch;

  window.fetch = function (...args) {
    // A URL pode vir como string, URL ou Request — normalizamos.
    const recurso = args[0];
    const url =
      typeof recurso === "string" ? recurso :
      recurso instanceof URL ? recurso.href :
      recurso && typeof recurso.url === "string" ? recurso.url : "";

    const promessa = fetchOriginal.apply(this, args);

    if (!urlInteressa(url)) return promessa;

    return promessa.then((resposta) => {
      // .clone() é OBRIGATÓRIO: o corpo de uma Response é um stream que só
      // pode ser lido UMA vez. Se lêssemos a resposta original, a Adalove
      // receberia um corpo vazio e a página quebraria sem dados.
      try {
        resposta
          .clone()
          .json()
          .then((payload) => repassar(url, payload))
          .catch(() => {
            /* Resposta não-JSON (ex.: 204, texto) — ignoramos em silêncio. */
          });
      } catch (erro) {
        console.warn("[Adata] Falha ao clonar resposta:", erro);
      }
      // A página SEMPRE recebe a resposta original, intacta.
      return resposta;
    });
  };

  // ---------------------------------------------------------------------
  // XMLHttpRequest
  // ---------------------------------------------------------------------

  // Mesma lógica do fetch: guardar os métodos originais do protótipo antes
  // de sobrescrever, senão perdemos o comportamento real do XHR.
  const openOriginal = XMLHttpRequest.prototype.open;
  const sendOriginal = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (metodo, url, ...resto) {
    // Anotamos a URL na própria instância para o send() saber se interessa.
    // Propriedade com prefixo próprio para não colidir com nada da página.
    this.__adataUrl = typeof url === "string" ? url : String(url);
    return openOriginal.call(this, metodo, url, ...resto);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    if (urlInteressa(this.__adataUrl)) {
      // "load" dispara depois que a página já pode ler a resposta; ler
      // responseText aqui não consome nada (diferente do stream do fetch),
      // então não há risco de quebrar a aplicação.
      this.addEventListener("load", () => {
        try {
          // responseType pode ser "json" (response já é objeto) ou ""/"text".
          const bruto = this.responseType === "json" ? this.response : this.responseText;
          const payload = typeof bruto === "string" ? JSON.parse(bruto) : bruto;
          if (payload) repassar(this.__adataUrl, payload);
        } catch {
          /* Corpo não-JSON — ignoramos. */
        }
      });
    }
    return sendOriginal.apply(this, args);
  };

  // ---------------------------------------------------------------------
  // Captura ativa
  // ---------------------------------------------------------------------

  /**
   * A interceptação passiva só captura quando a Adalove decide chamar a API
   * (ex.: a página de Vida Acadêmica). Para a captura acontecer em QUALQUER
   * recarga da Adalove, disparamos nós mesmos as chamadas de dados — com o
   * token de sessão do próprio aluno (Cognito, no localStorage da página) e
   * usando o window.fetch JÁ INTERCEPTADO: as respostas caem no fluxo normal
   * de captura sem nenhum código extra.
   *
   * Privacidade inalterada: são as mesmas requisições que a página faz, para
   * a mesma API do Inteli, com a mesma sessão; nada sai do navegador.
   */
  function capturaAtiva() {
    try {
      // A chave do Cognito tem prefixo dinâmico (client id); localizamos pelo
      // sufixo estável "accessToken".
      const chaveToken = Object.keys(localStorage).find((k) => k.includes("accessToken"));
      if (!chaveToken) return; // sem sessão (tela de login) — nada a fazer

      const opcoes = { headers: { Authorization: `Bearer ${localStorage.getItem(chaveToken)}` } };

      // fetchOriginal (não o interceptado) + repassar manual com origem
      // "ativa": se essas respostas passassem pelo fetch interceptado, o
      // background não teria como distinguir a varredura de fundo da
      // navegação real do aluno — e a turma ativa do popup pularia para a
      // última turma varrida em vez da que está aberta na Adalove.
      const buscarERepassar = (url) =>
        fetchOriginal(url, opcoes)
          .then((r) => r.json())
          .then((payload) => {
            repassar(url, payload, "ativa");
            return payload;
          });

      buscarERepassar(`https://${HOST_API}/sections`)
        .then((secoes) => {
          if (!Array.isArray(secoes)) return;
          for (const secao of secoes) {
            if (!secao || !secao.uuid) continue;
            // userdata é o payload que contém os cards, notas e attendance.
            buscarERepassar(`https://${HOST_API}/sections/${secao.uuid}/userdata`).catch(() => {});
          }
        })
        .catch(() => {
          /* API fora ou sessão expirada — a interceptação passiva continua. */
        });
    } catch {
      /* Nunca deixamos a captura ativa quebrar a página. */
    }
  }

  // Espera a página assentar antes de disparar: competir com o boot do bundle
  // da Adalove por rede/CPU poderia atrasar o carregamento percebido.
  if (document.readyState === "complete") {
    setTimeout(capturaAtiva, 1500);
  } else {
    window.addEventListener("load", () => setTimeout(capturaAtiva, 1500));
  }

  console.debug("[Adata] Interceptor instalado.");
})();
