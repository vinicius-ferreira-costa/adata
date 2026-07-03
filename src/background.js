/**
 * background.js — service worker da extensão (MV3).
 *
 * Papel: receber os payloads capturados pelo content script, extrair as
 * atividades de forma defensiva, classificar (autoestudos × notas) e
 * persistir em chrome.storage.local com MERGE — nunca sobrescrevendo o
 * conjunto inteiro, senão o aluno perderia o que já capturou ao navegar
 * entre telas da Adalove.
 *
 * Formato do storage:
 *   autoestudos : { [studentActivityUuid]: objetoBrutoDaAPI, ... }
 *   notas       : { [studentActivityUuid]: objetoBrutoDaAPI, ... }
 *   urlsCapturadas : [ "https://apiv2...", ... ]  (únicas)
 *   ultimaCaptura  : timestamp (ms)
 *
 * Guardamos os objetos BRUTOS da API. A normalização (dedupe, eixo, semana)
 * acontece no popup via normalize.js/notas.js. Motivo: o formato exato do
 * payload ainda é desconhecido; guardar o dado cru permite evoluir a camada
 * de normalização sem perder capturas antigas.
 */

"use strict";

// ---------------------------------------------------------------------------
// Extração defensiva
// ---------------------------------------------------------------------------

/**
 * Procura a lista de atividades dentro de um payload de formato desconhecido.
 *
 * Por quê tão defensivo? Nesta fase não temos o contrato da API apiv2 — só
 * sabemos que em algum lugar do JSON existe um array de objetos com a chave
 * studentActivityUuid. Testamos primeiro os caminhos mais comuns em APIs REST
 * e, se nada casar, fazemos uma varredura recursiva. O caminho que funcionou
 * é logado para facilitar o diagnóstico ao vivo (abrir o console do service
 * worker e ver qual formato a API realmente usa).
 *
 * @param {*} payload JSON cru vindo da API.
 * @returns {{ atividades: object[], caminho: string }} lista (possivelmente
 *          vazia) e o caminho que a encontrou.
 */
function extrairAtividades(payload) {
  // A presença de studentActivityUuid é OBRIGATÓRIA em todos os caminhos:
  // a Adalove chama vários endpoints que devolvem arrays de objetos que NÃO
  // são atividades (/sections devolve a lista de turmas, /posts o feed,
  // /notifications os avisos). Sem essa exigência, as turmas entravam no
  // storage como se fossem cards — bug observado ao vivo.
  const ehListaDeAtividades = (valor) =>
    Array.isArray(valor) &&
    valor.length > 0 &&
    valor.every((item) => item && typeof item === "object") &&
    valor.some((item) => "studentActivityUuid" in item);

  // Caminhos comuns, do mais provável ao menos provável.
  const candidatos = [
    ["(raiz)", payload],
    ["payload.data", payload && payload.data],
    ["payload.data.activities", payload && payload.data && payload.data.activities],
    ["payload.activities", payload && payload.activities],
    ["payload.results", payload && payload.results],
    ["payload.content", payload && payload.content],
  ];

  for (const [caminho, valor] of candidatos) {
    if (ehListaDeAtividades(valor)) {
      return { atividades: valor, caminho };
    }
  }

  // Último recurso: varredura recursiva atrás do primeiro array de objetos
  // que contenham studentActivityUuid. Limitamos a profundidade para não
  // travar o worker com payloads patológicos (ciclos não existem em JSON,
  // mas payloads gigantes existem).
  const PROFUNDIDADE_MAX = 6;

  function varrer(no, caminho, profundidade) {
    if (!no || typeof no !== "object" || profundidade > PROFUNDIDADE_MAX) return null;

    if (ehListaDeAtividades(no)) {
      return { atividades: no, caminho };
    }

    const filhos = Array.isArray(no) ? no.entries() : Object.entries(no);
    for (const [chave, valor] of filhos) {
      const achado = varrer(valor, `${caminho}.${chave}`, profundidade + 1);
      if (achado) return achado;
    }
    return null;
  }

  const achado = varrer(payload, "payload", 0);
  if (achado) return achado;

  return { atividades: [], caminho: "(nenhum)" };
}

// ---------------------------------------------------------------------------
// Classificação autoestudos × notas
// ---------------------------------------------------------------------------

/**
 * Classificação POR ITEM, não por payload.
 *
 * Contrato real observado ao vivo (GET /sections/{uuid}/userdata): UM ÚNICO
 * payload traz TODOS os cards do módulo (~275 itens) — autoestudos, aulas,
 * artefatos e ponderadas juntos. Cada item tem SEMPRE as chaves caption,
 * folderCaption e gradeWeight; o que distingue uma avaliação que vale nota é
 * o VALOR gradeWeight > 0 (32 itens no módulo observado).
 *
 * A versão anterior classificava o payload inteiro por maioria de votos de
 * presença de chave — como todo item tem gradeWeight E caption, tudo caía em
 * "notas" e a aba de autoestudos ficava vazia. Por isso a regra agora é por
 * item e por VALOR:
 *   - todo item é um card → vai para "autoestudos";
 *   - item com gradeWeight > 0 → vai TAMBÉM para "notas".
 */
function valeNota(item) {
  const peso = Number(item.gradeWeight ?? item.weight ?? item.peso ?? 0);
  return Number.isFinite(peso) && peso > 0;
}

// ---------------------------------------------------------------------------
// Persistência com merge
// ---------------------------------------------------------------------------

/** Extrai a chave de identidade de um item, com fallbacks. */
function chaveDoItem(item) {
  return item.studentActivityUuid || item.uuid || item.id || null;
}

/**
 * Fila de escrita: chrome.storage.local.get/set são assíncronos, e duas
 * mensagens processadas em paralelo fariam read-modify-write concorrente
 * (a segunda escrita apagaria a primeira). Serializar via encadeamento de
 * Promise resolve sem precisar de locks.
 */
let filaDeEscrita = Promise.resolve();

/**
 * Descobre a que TURMA (section) o payload pertence. Sem essa separação as
 * atividades de módulos diferentes se misturam num pool único e a média
 * calculada sai errada ao trocar de turma — bug observado ao vivo.
 * Fontes, em ordem: sectionUuid dos próprios itens; uuid na URL
 * (/sections/{uuid}/userdata); "desconhecida" como último recurso (melhor
 * agrupar num balde visível do que perder a captura).
 */
function turmaDoPayload(url, atividades) {
  const doItem = atividades.find((a) => a.sectionUuid)?.sectionUuid;
  if (doItem) return doItem;
  const daUrl = /sections\/([0-9a-f-]+)/i.exec(String(url));
  if (daUrl) return daUrl[1];
  return "desconhecida";
}

/** Badge no ícone: nº de cards da turma ativa — feedback de captura sem abrir o popup. */
function atualizarBadge(qtd) {
  // setBadgeText falha silenciosamente se a API não existir (testes/futuro).
  if (chrome.action && chrome.action.setBadgeText) {
    chrome.action.setBadgeText({ text: qtd > 0 ? String(Math.min(qtd, 999)) : "" });
    chrome.action.setBadgeBackgroundColor({ color: "#6d28d9" });
  }
}

function processarPayload(url, payload, origem) {
  filaDeEscrita = filaDeEscrita
    .then(async () => {
      const { atividades, caminho } = extrairAtividades(payload);

      // studentStatus vem no MESMO payload das atividades e traz as métricas
      // oficiais já calculadas pela Adalove (médias, faltas, status). Guardar
      // a fonte oficial evita divergência entre o nosso cálculo e o da
      // plataforma — o nosso vira ferramenta de simulação, não de verdade.
      const statusAluno =
        payload && typeof payload === "object" && payload.studentStatus &&
        typeof payload.studentStatus === "object"
          ? payload.studentStatus
          : null;

      if (atividades.length === 0) {
        console.debug(`[Adata] Payload sem atividades (${url})`);
        return;
      }

      const armazenado = await chrome.storage.local.get({
        capturas: {},
        urlsCapturadas: [],
      });

      // Uma entrada por TURMA: atividades, status oficial e rótulo juntos.
      const turmaUuid = turmaDoPayload(url, atividades);
      const turma = armazenado.capturas[turmaUuid] || { atividades: {}, statusAluno: null, rotulo: "" };

      // MERGE por uuid dentro da turma: itens novos entram, itens já vistos
      // são atualizados (a captura mais recente vence — ex.: nota lançada
      // depois). Itens sem chave são descartados com log, nunca em silêncio.
      let descartados = 0;
      let comNota = 0;
      for (const item of atividades) {
        const chave = chaveDoItem(item);
        if (!chave) {
          descartados++;
          continue;
        }
        turma.atividades[chave] = item;
        if (valeNota(item)) comNota++;
      }
      if (descartados > 0) {
        console.warn(`[Adata] ${descartados} itens sem studentActivityUuid/uuid/id descartados.`);
      }

      if (statusAluno) {
        turma.statusAluno = statusAluno;
        if (statusAluno.sectionCaption) turma.rotulo = String(statusAluno.sectionCaption).trim();
      }
      if (!turma.rotulo) turma.rotulo = turmaUuid.slice(0, 8);
      turma.ultimaCaptura = Date.now();
      armazenado.capturas[turmaUuid] = turma;

      console.log(
        `[Adata] ${atividades.length} itens via "${caminho}" (${comNota} valem nota) → turma ${turma.rotulo} (${url})`
      );

      const urls = new Set(armazenado.urlsCapturadas);
      urls.add(url);

      const gravacao = {
        capturas: armazenado.capturas,
        urlsCapturadas: [...urls],
        ultimaCaptura: Date.now(),
      };
      // turmaAtiva segue a NAVEGAÇÃO do aluno: só a captura passiva (a
      // própria Adalove pediu esses dados — a turma está aberta na tela)
      // move o ponteiro. A varredura ativa cobre todas as turmas em
      // sequência e apontaria para a última varrida, não para a aberta.
      if (origem !== "ativa") gravacao.turmaAtiva = turmaUuid;

      await chrome.storage.local.set(gravacao);
      // Chaves do formato antigo (pool único) — removidas para não confundir
      // diagnóstico; o formato por turma é a única fonte a partir daqui.
      await chrome.storage.local.remove(["autoestudos", "notas", "statusAluno"]);

      atualizarBadge(Object.keys(turma.atividades).length);
    })
    .catch((erro) => console.error("[Adata] Erro ao processar payload:", erro));

  return filaDeEscrita;
}

// ---------------------------------------------------------------------------
// Migração do formato antigo (pool único → por turma)
// ---------------------------------------------------------------------------

/**
 * Versões anteriores guardavam todos os itens num pool único (chaves
 * "autoestudos"/"notas"). Se o aluno atualizou a extensão sem recapturar,
 * esses dados ainda existem — reagrupamos por sectionUuid (cada item bruto
 * carrega o da sua turma) para dentro de "capturas", sem perder nada.
 * Roda a cada início do service worker; sem dado antigo, é no-op.
 */
async function migrarFormatoAntigo() {
  const antigo = await chrome.storage.local.get(["autoestudos", "notas", "capturas"]);
  const poolAntigo = { ...(antigo.notas || {}), ...(antigo.autoestudos || {}) };
  if (Object.keys(poolAntigo).length === 0) return;

  const capturas = antigo.capturas || {};
  let migrados = 0;
  for (const [chave, item] of Object.entries(poolAntigo)) {
    const turmaUuid = (item && item.sectionUuid) || "desconhecida";
    const turma = capturas[turmaUuid] || { atividades: {}, statusAluno: null, rotulo: "" };
    // Merge conservador: captura nova (formato atual) vence a migrada.
    if (!(chave in turma.atividades)) {
      turma.atividades[chave] = item;
      migrados++;
    }
    if (!turma.rotulo) turma.rotulo = turmaUuid.slice(0, 8);
    turma.ultimaCaptura = turma.ultimaCaptura || Date.now();
    capturas[turmaUuid] = turma;
  }

  await chrome.storage.local.set({ capturas });
  await chrome.storage.local.remove(["autoestudos", "notas", "statusAluno"]);
  console.log(`[Adata] Migração: ${migrados} itens do formato antigo reagrupados por turma.`);
}

// Entra na fila de escrita para não competir com capturas simultâneas.
filaDeEscrita = filaDeEscrita.then(migrarFormatoAntigo).catch((erro) =>
  console.error("[Adata] Erro na migração:", erro)
);

// ---------------------------------------------------------------------------
// Mensagens
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((mensagem, _remetente, sendResponse) => {
  if (!mensagem) return false;

  // Autodiagnóstico: o popup pergunta se o worker desta versão está de pé e
  // o que há no storage. Serve para o aluno (e para o suporte) distinguir
  // "não capturou" de "worker antigo rodando após atualização sem reload".
  if (mensagem.type === "ADATA_PING") {
    chrome.storage.local
      .get({ capturas: {}, urlsCapturadas: [], ultimaCaptura: null })
      .then((dados) =>
        sendResponse({
          ok: true,
          versao: chrome.runtime.getManifest().version,
          turmas: Object.keys(dados.capturas).length,
          urls: dados.urlsCapturadas.length,
          ultimaCaptura: dados.ultimaCaptura,
        })
      );
    return true;
  }

  if (mensagem.type !== "ADATA_PAYLOAD") return false;

  processarPayload(mensagem.url, mensagem.payload, mensagem.origem).then(() =>
    sendResponse({ ok: true })
  );
  // true = resposta assíncrona; mantém o canal aberto até o sendResponse.
  return true;
});
