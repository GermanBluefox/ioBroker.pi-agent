'use strict';

/**
 * Single source of the eleven languages: writes admin/i18n/<lang>.json and the
 * titleLang / desc / news entries of io-package.json. Run: npm run i18n
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const LANGS = ['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];

/** key (English text) -> [en, de, ru, pt, nl, fr, it, es, pl, uk, zh-cn] */
const ADMIN = {
	Provider: ['Provider', 'Anbieter', 'Провайдер', 'Provedor', 'Aanbieder', 'Fournisseur', 'Fornitore', 'Proveedor', 'Dostawca', 'Провайдер', '提供商'],
	Model: ['Model', 'Modell', 'Модель', 'Modelo', 'Taalmodel', 'Modèle', 'Modello', 'Modelo', 'Model językowy', 'Модель', '模型'],
	'API key': ['API key', 'API-Schlüssel', 'API-ключ', 'Chave de API', 'API-sleutel', 'Clé API', 'Chiave API', 'Clave de API', 'Klucz API', 'API-ключ', 'API 密钥'],
	'Dry run': ['Dry run', 'Probelauf', 'Пробный запуск', 'Execução de teste', 'Proefrun', 'Essai à blanc', 'Prova a secco', 'Ejecución de prueba', 'Próba bez zapisu', 'Пробний запуск', '试运行'],
	'Log write requests instead of executing them': [
		'Log write requests instead of executing them',
		'Schreibanfragen nur protokollieren, nicht ausführen',
		'Только записывать запросы на запись в журнал, не выполняя их',
		'Registar os pedidos de escrita em vez de os executar',
		'Schrijfverzoeken alleen loggen en niet uitvoeren',
		"Journaliser les demandes d'écriture au lieu de les exécuter",
		'Registra le richieste di scrittura invece di eseguirle',
		'Registrar las solicitudes de escritura en lugar de ejecutarlas',
		'Zapisuj żądania zapisu w dzienniku zamiast je wykonywać',
		'Лише записувати запити на запис у журнал, не виконуючи їх',
		'仅记录写入请求而不执行',
	],
	'Leave empty to use the default model of the provider': [
		'Leave empty to use the default model of the provider',
		'Leer lassen, um das Standardmodell des Anbieters zu verwenden',
		'Оставьте пустым, чтобы использовать модель провайдера по умолчанию',
		'Deixe vazio para usar o modelo padrão do provedor',
		'Leeg laten om het standaardmodel van de aanbieder te gebruiken',
		'Laisser vide pour utiliser le modèle par défaut du fournisseur',
		'Lasciare vuoto per usare il modello predefinito del fornitore',
		'Dejar vacío para usar el modelo predeterminado del proveedor',
		'Pozostaw puste, aby użyć domyślnego modelu dostawcy',
		'Залиште порожнім, щоб використовувати модель провайдера за замовчуванням',
		'留空以使用提供商的默认模型',
	],
	'Write allowlist': ['Write allowlist', 'Schreib-Freigabeliste', 'Список разрешённых записей', 'Lista de escrita permitida', 'Toegestane schrijflijst', "Liste d'écriture autorisée", 'Elenco di scrittura consentita', 'Lista de escritura permitida', 'Lista dozwolonych zapisów', 'Список дозволених записів', '写入白名单'],
	'One regular expression per line. The agent may only write states whose ID matches one of them.': [
		'One regular expression per line. The agent may only write states whose ID matches one of them.',
		'Ein regulärer Ausdruck pro Zeile. Der Agent darf nur Datenpunkte schreiben, deren ID zu einem davon passt.',
		'Одно регулярное выражение в строке. Агент может записывать только состояния, ID которых соответствует одному из них.',
		'Uma expressão regular por linha. O agente só pode escrever estados cujo ID corresponda a uma delas.',
		'Eén reguliere expressie per regel. De agent mag alleen states schrijven waarvan de ID overeenkomt met een ervan.',
		"Une expression régulière par ligne. L'agent ne peut écrire que les états dont l'ID correspond à l'une d'elles.",
		"Un'espressione regolare per riga. L'agente può scrivere solo gli stati il cui ID corrisponde a una di esse.",
		'Una expresión regular por línea. El agente solo puede escribir estados cuyo ID coincida con alguna de ellas.',
		'Jedno wyrażenie regularne w wierszu. Agent może zapisywać tylko stany, których ID pasuje do jednego z nich.',
		'Один регулярний вираз у рядку. Агент може записувати лише стани, ID яких відповідає одному з них.',
		'每行一个正则表达式。代理只能写入 ID 与其中之一匹配的状态。',
	],
	Instructions: ['Instructions', 'Anweisungen', 'Инструкции', 'Instruções', 'Instructies', 'Consignes', 'Istruzioni', 'Instrucciones', 'Instrukcje', 'Інструкції', '指令'],
	'Additional instructions for the agent': [
		'Additional instructions for the agent',
		'Zusätzliche Anweisungen für den Agenten',
		'Дополнительные инструкции для агента',
		'Instruções adicionais para o agente',
		'Aanvullende instructies voor de agent',
		"Consignes supplémentaires pour l'agent",
		"Istruzioni aggiuntive per l'agente",
		'Instrucciones adicionales para el agente',
		'Dodatkowe instrukcje dla agenta',
		'Додаткові інструкції для агента',
		'给代理的附加指令',
	],
};

const TITLE = 'Pi Agent';
const DESC = [
	'Durable LLM agent that reads and controls ioBroker states and survives restarts and crashes',
	'Dauerhafter LLM-Agent, der ioBroker-Datenpunkte liest und steuert und Neustarts und Abstürze übersteht',
	'Устойчивый LLM-агент, который читает и управляет состояниями ioBroker и переживает перезапуски и сбои',
	'Agente LLM durável que lê e controla estados do ioBroker e sobrevive a reinícios e falhas',
	'Duurzame LLM-agent die ioBroker-states leest en bestuurt en herstarts en crashes overleeft',
	"Agent LLM durable qui lit et pilote les états d'ioBroker et survit aux redémarrages et aux plantages",
	'Agente LLM durevole che legge e controlla gli stati di ioBroker e sopravvive a riavvii e arresti anomali',
	'Agente LLM duradero que lee y controla estados de ioBroker y sobrevive a reinicios y fallos',
	'Trwały agent LLM, który odczytuje i steruje stanami ioBroker oraz przetrwa restarty i awarie',
	'Стійкий LLM-агент, який читає та керує станами ioBroker і переживає перезапуски та збої',
	'可持久运行的 LLM 代理，读取并控制 ioBroker 状态，可在重启和崩溃后恢复',
];
const NEWS = [
	'Initial version: durable agent with search, read and allowlisted write tools',
	'Erste Version: dauerhafter Agent mit Such-, Lese- und Schreibwerkzeugen mit Freigabeliste',
	'Первая версия: устойчивый агент с инструментами поиска, чтения и записи по списку разрешений',
	'Versão inicial: agente durável com ferramentas de pesquisa, leitura e escrita com lista de permissões',
	'Eerste versie: duurzame agent met zoek-, lees- en schrijftools met toegestane lijst',
	"Version initiale : agent durable avec outils de recherche, de lecture et d'écriture avec liste autorisée",
	'Versione iniziale: agente durevole con strumenti di ricerca, lettura e scrittura con elenco consentito',
	'Versión inicial: agente duradero con herramientas de búsqueda, lectura y escritura con lista permitida',
	'Wersja początkowa: trwały agent z narzędziami wyszukiwania, odczytu i zapisu z listą dozwolonych',
	'Перша версія: стійкий агент з інструментами пошуку, читання та запису зі списком дозволених',
	'初始版本：具有搜索、读取以及带白名单写入工具的持久代理',
];

const byLang = (list, i) => list[i];

fs.mkdirSync(path.join(root, 'admin', 'i18n'), { recursive: true });
LANGS.forEach((lang, i) => {
	const out = {};
	for (const [key, values] of Object.entries(ADMIN)) {
		out[key] = values[i];
	}
	fs.writeFileSync(path.join(root, 'admin', 'i18n', `${lang}.json`), `${JSON.stringify(out, null, '\t')}\n`);
});

const file = path.join(root, 'io-package.json');
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
pkg.common.titleLang = Object.fromEntries(LANGS.map(l => [l, TITLE]));
pkg.common.desc = Object.fromEntries(LANGS.map((l, i) => [l, byLang(DESC, i)]));
pkg.common.news = { [pkg.common.version]: Object.fromEntries(LANGS.map((l, i) => [l, byLang(NEWS, i)])) };
fs.writeFileSync(file, `${JSON.stringify(pkg, null, '\t')}\n`);
JSON.parse(fs.readFileSync(file, 'utf8')); // validate what was written
console.log('i18n written for', LANGS.length, 'languages');
