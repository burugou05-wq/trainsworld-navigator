import { readFile } from 'node:fs/promises';
import { importSave } from '../src/save.mjs';
import { buildGraph, searchRoutes } from '../src/router.mjs';

const [file, from, to] = process.argv.slice(2);
if (!file) {
  console.error('npm run extract -- <セーブファイル> [出発駅ID 到着駅ID]');
  process.exitCode = 1;
} else {
  try {
    const network = await importSave(new Blob([await readFile(file)]));
    if (from === undefined) {
      console.log(JSON.stringify(network, null, 2));
    } else {
      const graph = buildGraph(network);
      const routes = searchRoutes(graph, graph.complexOf.get(Number(from)), graph.complexOf.get(Number(to)));
      console.log(JSON.stringify(routes.map(({ legs, ...route }) => ({
        ...route, legs: legs.map(({ line, ...leg }) => ({
          ...leg, line: line.name, stops: leg.stops.map(id => [id, graph.stations.get(id).name]),
        })),
      })), null, 2));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
