import { SourceUnit, VariableDeclaration } from 'solidity-ast';
import { findAll } from 'solidity-ast/utils';
import { getNodeBounds } from '../solc/ast-utils';
import { TransformerTools } from '../transform';
import { Transformation } from './type';
import { newFunctionPosition } from './utils/new-function-position';
import { formatLines } from './utils/format-lines';
import { isStorageVariable } from './utils/is-storage-variable';
import { erc7201Location } from '../utils/erc7201';

export function getNamespaceStructName(contractName: string): string {
  return contractName + 'Storage';
}

export function addNamespaceStruct(include?: (source: string) => boolean) {
  return function* (sourceUnit: SourceUnit, tools: TransformerTools): Generator<Transformation> {
    if (!include?.(sourceUnit.absolutePath)) {
      return;
    }

    const { error, resolver, getRealEndIndex } = tools;

    for (const contract of findAll('ContractDefinition', sourceUnit)) {
      let start = newFunctionPosition(contract, tools);

      let finished = false;

      const nonStorageVars: [number, VariableDeclaration][] = [];
      const storageVars: VariableDeclaration[] = [];

      for (const n of contract.nodes) {
        if (n.nodeType === 'VariableDeclaration' && (storageVars.length > 0 || isStorageVariable(n, resolver))) {
          if (finished) {
            throw error(n, 'All variables in the contract must be contiguous');
          }

          if (!isStorageVariable(n, resolver)) {
            const varStart = getRealEndIndex(storageVars.at(-1)!) + 1;
            nonStorageVars.push([varStart, n]);
          } else {
            storageVars.push(n);
          }
        } else if (storageVars.length > 0) {
          finished = true;
        } else {
          start = getRealEndIndex(n) + 1;
        }
      }

      for (const [s, v] of nonStorageVars) {
        const bounds = { start: s, length: getRealEndIndex(v) + 1 - s };
        let removed = '';

        yield {
          kind: 'relocate-nonstorage-var-remove',
          ...bounds,
          transform: source => {
            removed = source;
            return '';
          },
        };

        yield {
          kind: 'relocate-nonstorage-var-reinsert',
          start,
          length: 0,
          text: removed,
        };
      }

      if (nonStorageVars.length > 0) {
        yield {
          kind: 'relocate-nonstorage-var-newline',
          start,
          length: 0,
          text: '\n',
        };
      }

      if (storageVars.length > 0) {
        for (const v of storageVars) {
          const { start, length } = getNodeBounds(v);
          yield {
            kind: 'remove-var-modifier',
            start,
            length,
            transform: source => source.replace(/\s*\bprivate\b/g, ''),
          };
        }

        const namespace = getNamespaceStructName(contract.name);
        const id = 'openzeppelin.storage.' + contract.name;

        const end = getRealEndIndex(storageVars.at(-1)!) + 1;

        yield {
          kind: 'add-namespace-struct',
          start,
          length: end - start,
          transform: source => {
            const [, leading, rest] = source.match(/^((?:[ \t\v\f]*[\n\r]+)*)(.*)$/s)!;
            return (
              leading +
              formatLines(1, [
                `/// @custom:storage-location erc7201:${id}`,
                `struct ${namespace} {`,
                ...rest.split('\n'),
                `}`,
                ``,
                `// keccak256(abi.encode(uint256(keccak256("${id}")) - 1))`,
                `bytes32 private constant ${namespace}Location = ${erc7201Location(id)};`,
                ``,
                `function _get${namespace}() private pure returns (${namespace} storage $) {`,
                [`assembly {`, [`$.slot := ${namespace}Location`], `}`],
                `}`,
              ]).trimEnd()
            );
          },
        };

        for (const fnDef of findAll('FunctionDefinition', contract)) {
          for (const ref of fnDef.modifiers.flatMap(m => [...findAll('Identifier', m)])) {
            const varDecl = resolver.tryResolveNode(
              'VariableDeclaration',
              ref.referencedDeclaration!,
            );
            if (varDecl && isStorageVariable(varDecl, resolver)) {
              throw error(ref, 'Unsupported storage variable found in modifier');
            }
          }

          let foundReferences = false;
          if (fnDef.body) {
            for (const ref of findAll('Identifier', fnDef.body)) {
              const varDecl = resolver.tryResolveNode(
                'VariableDeclaration',
                ref.referencedDeclaration!,
              );
              if (varDecl && isStorageVariable(varDecl, resolver)) {
                if (varDecl.scope !== contract.id) {
                  throw error(varDecl, 'Namespaces assume all variables are private');
                }
                foundReferences = true;
                const { start } = getNodeBounds(ref);
                yield { kind: 'add-namespace-ref', start, length: 0, text: '$.' };
              }
            }

            if (foundReferences) {
              const { start: fnBodyStart } = getNodeBounds(fnDef.body);
              yield {
                kind: 'add-namespace-base-ref',
                start: fnBodyStart + 1,
                length: 0,
                text: `\n        ${namespace} storage $ = _get${namespace}();`,
              };
            }
          }
        }
      }
    }
  }
}
