export function commandEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'LANG', 'LC_ALL']) {
    const key = Object.keys(process.env).find(key => key.toLowerCase() === name.toLowerCase());
    if (key && process.env[key]) result[name] = process.env[key];
  }
  return result;
}
