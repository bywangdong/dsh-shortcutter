export async function assembleClient(read) {
  const client = await read('src/client.js');
  const parts = {
    CORE: 'core.js', NAVIGATION: 'default-navigation.js', TOOLS: 'tool-tabs.js',
    TOOL_NAVIGATION: 'tool-navigation.js', SESSION_SEARCH: 'session-search.js', CSS: 'styles.css'
  };
  const modules = await Promise.all(Object.entries(parts).map(async ([name, file]) => {
    const marker = `/* BUILD_${name} */`;
    if (!client.includes(marker)) return [marker, ''];
    const content = await read('src/' + file);
    if (name === 'CSS') return [marker, `const STYLE = ${JSON.stringify(content)};`];
    let source = content.replace(/^export /gm, '');
    const searchImport = 'import { TextSearchIndex } from "./vendor/text-search.js";';
    if (name === 'SESSION_SEARCH' && source.includes(searchImport)) {
      const library = await read('src/vendor/text-search.js');
      source = source.replace(searchImport, () => library.replace(/^export /gm, ''));
    }
    return [marker, source];
  }));
  return modules.reduce((source, [marker, content]) => source.replace(marker, () => content), client);
}
