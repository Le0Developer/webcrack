import type { NodePath } from '@babel/traverse';
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import {
  constMemberExpression,
  declarationOrAssignment,
  inlineArrayElements,
  isReadonlyObject,
  renameFast,
  undefinedMatcher,
} from '../ast-utils';
import debug from 'debug';

export interface StringArray {
  path: NodePath<t.FunctionDeclaration>;
  references: NodePath[];
  name: string;
  originalName: string;
  length: number;
}

export function findStringArray(ast: t.Node): StringArray | undefined {
  let result: StringArray | undefined;
  const functionName = m.capture(m.anyString());
  const arrayIdentifier = m.capture(m.identifier());
  const arrayExpression = m.capture(
    m.or(
      // ["hello", "world"]
      m.arrayExpression(m.arrayOf(m.or(m.stringLiteral(), undefinedMatcher))),
      // "hello,world".split(",")
      m.callExpression(constMemberExpression(m.stringLiteral(), 'split'), [
        m.stringLiteral(),
      ]),
    ),
  );
  // getStringArray = function () { return array; };
  const functionAssignment = m.assignmentExpression(
    '=',
    m.identifier(m.fromCapture(functionName)),
    m.functionExpression(
      undefined,
      m.zeroOrMore(),
      m.blockStatement([m.returnStatement(m.fromCapture(arrayIdentifier))]),
    ),
  );
  const variableDeclaration = declarationOrAssignment(
    arrayIdentifier,
    arrayExpression,
  );
  // function getStringArray() { ... }
  const matcher = m.functionDeclaration(
    m.identifier(functionName),
    m.zeroOrMore(),
    m.or(
      // var array = ["hello", "world"];
      // return (getStringArray = function () { return array; })();
      m.blockStatement([
        variableDeclaration,
        m.returnStatement(m.callExpression(functionAssignment)),
      ]),
      // var array = ["hello", "world"];
      // getStringArray = function () { return array; });
      // return getStringArray();
      m.blockStatement([
        variableDeclaration,
        m.expressionStatement(functionAssignment),
        m.returnStatement(m.callExpression(m.identifier(functionName))),
      ]),
    ),
  );

  function getArray() {
    const current = arrayExpression.current!;
    if (current.type === 'ArrayExpression') {
      return current;
    }
    const split = current.arguments[0] as t.StringLiteral;
    const content = (current.callee as t.MemberExpression)
      .object as t.StringLiteral;
    const elements = content.value
      .split(split.value)
      .map((v) => t.stringLiteral(v));
    return t.arrayExpression(elements);
  }

  traverse(ast, {
    // Wrapped string array from later javascript-obfuscator versions
    FunctionDeclaration(path) {
      if (matcher.match(path.node)) {
        const length = getArray().elements.length;
        const logger = debug('webcrack:deobfuscate');
        logger(`String Array: ${functionName.current}, length ${length}`);
        const name = functionName.current!;
        const binding = path.scope.getBinding(name)!;
        renameFast(binding, '__STRING_ARRAY__');

        result = {
          path,
          references: binding.referencePaths,
          originalName: name,
          name: '__STRING_ARRAY__',
          length,
        };
        path.stop();
      }
    },
    // Simple string array inlining (only `array[0]`, `array[1]` etc references, no rotating/decoding).
    // May be used by older or different obfuscators
    VariableDeclaration(path) {
      if (!variableDeclaration.match(path.node)) return;

      const array = getArray();
      const length = array.elements.length;
      const binding = path.scope.getBinding(arrayIdentifier.current!.name)!;
      const memberAccess = m.memberExpression(
        m.fromCapture(arrayIdentifier),
        m.numericLiteral(m.matcher((value) => value < length)),
      );
      if (!binding.referenced || !isReadonlyObject(binding, memberAccess))
        return;

      inlineArrayElements(array, binding.referencePaths);
      path.remove();
    },
  });

  return result;
}
