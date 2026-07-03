# Política de Privacidade — Adata

_Última atualização: julho de 2026_

## Resumo

**Nenhum dado do aluno sai do navegador. Nunca.**

A Adata não possui servidor, não faz chamadas de rede próprias, não usa
serviços de analytics e não compartilha informação com terceiros — nem com
os desenvolvedores da extensão.

## O que a extensão coleta

Ao navegar em `adalove.inteli.edu.br`, a extensão observa as respostas que a
própria plataforma Adalove recebe da API do Inteli (`apiv2.inteli.edu.br`)
e, a cada carga da página, consulta ela mesma essa API — as mesmas rotas de
leitura que a plataforma usa, com a sessão do próprio aluno, a partir do
navegador dele. Nos dois casos guarda localmente:

- os cards de autoestudo (título, semana, professor, descrição, link);
- os registros de notas e pesos das avaliações;
- as URLs das chamadas capturadas e o horário da última captura;
- valores de presença informados manualmente pelo aluno no popup.

## Onde os dados ficam

Exclusivamente em `chrome.storage.local`, o armazenamento local do próprio
navegador do usuário, no próprio dispositivo. Os dados:

- **não** são enviados a nenhum servidor;
- **não** são sincronizados entre dispositivos (não usamos `storage.sync`);
- **não** são acessíveis a outros sites ou extensões.

## Exportações

Os arquivos CSV/Markdown são gerados localmente no navegador (via Blob) e
salvos apenas quando o usuário clica em exportar. O conteúdo copiado para a
área de transferência também é gerado localmente e só sai dela se o próprio
usuário o colar em outro lugar.

## Permissões solicitadas e por quê

| Permissão | Motivo |
| --- | --- |
| `storage` | Guardar os dados capturados localmente. |
| Acesso a `adalove.inteli.edu.br` | Rodar o script de captura apenas nesse site. |
| Acesso a `apiv2.inteli.edu.br` | Identificar as respostas da API de dados acadêmicos. |

Nenhuma outra permissão é solicitada.

## Remoção dos dados

Desinstalar a extensão remove todos os dados armazenados. Eles também podem
ser apagados em `chrome://extensions` → Adata → "Limpar dados".

## Contato

Dúvidas sobre esta política: abra uma issue no repositório do projeto.
