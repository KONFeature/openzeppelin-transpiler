import { SourceUnit } from 'solidity-ast';
import { findAll } from 'solidity-ast/utils';

import { renameContract } from '../rename';
import { getNodeBounds, getNodeSources } from '../solc/ast-utils';
import { ContractDefinition } from '../solc/ast-node';
import { Transformation } from './type';

export function* transformContractName2(
  sourceUnit: SourceUnit,
  _: unknown,
  original: string,
): Generator<Transformation> {
  for (const contract of findAll('ContractDefinition', sourceUnit)) {
    const bounds = getNodeBounds(contract);
    const re = /(?:abstract\s+)?(?:contract|library|interface)\s+([a-zA-Z0-9$_]+)/y;
    re.lastIndex = bounds.start;
    const match = re.exec(original);

    if (match === null) {
      throw new Error(`Can't find ${contract.name} in ${sourceUnit.absolutePath}`);
    }

    yield {
      start: match.index,
      length: match[0].length,
      kind: 'transform-contract-name',
      transform: source => source.replace(/[a-zA-Z0-9$_]+$/, renameContract),
    };
  }
}

export function transformContractName(
  contractNode: ContractDefinition,
  source: string,
  newName: string,
): Transformation {
  const [start, , nodeSource] = getNodeSources(contractNode, source);

  const subStart = nodeSource.indexOf(contractNode.name);
  if (subStart === -1) {
    throw new Error(`Can't find ${contractNode.name} in ${nodeSource}`);
  }

  return {
    kind: 'transform-contract-name',
    start: start + subStart,
    length: contractNode.name.length,
    text: newName,
  };
}
