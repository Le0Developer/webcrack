import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import { renameFast, type Transform } from '../ast-utils';
import { generateUid } from '../ast-utils/scope';

export default {
  name: 'mangle',
  tags: ['safe'],
  scope: true,
  visitor(match = () => true) {
    return {
      BindingIdentifier: {
        exit(path) {
          if (!path.isBindingIdentifier()) return;
          if (path.parentPath.isImportSpecifier()) return;
          if (path.parentPath.isObjectProperty()) return;
          const matched = match(path.node.name);
          if (!matched) return;

          const binding = path.scope.getBinding(path.node.name);
          if (!binding) return;
          if (
            binding.referencePaths.some((ref) => ref.isExportNamedDeclaration())
          )
            return;

          renameFast(binding, inferName(path, matched === 'stable'));
        },
      },
    };
  },
} satisfies Transform<(id: string) => boolean | 'stable'>;

const requireMatcher = m.variableDeclarator(
  m.identifier(),
  m.callExpression(m.identifier('require'), [m.stringLiteral()]),
);

function getScopeName(
  path: NodePath<t.Identifier>,
  stable: boolean,
): string | null {
  if (path.parentPath.isClass({ id: path.node })) {
    return 'C' + (stable ? `_${path.parentPath.node.body.body.length}` : '');
  } else if (path.parentPath.isFunction({ id: path.node })) {
    return 'f' + (stable ? `_${path.parentPath.node.params.length}` : '');
  } else if (
    path.listKey === 'params' ||
    (path.parentPath.isAssignmentPattern({ left: path.node }) &&
      path.parentPath.listKey === 'params')
  ) {
    return 'p';
  } else if (requireMatcher.match(path.parent)) {
    return (
      path.parentPath.get('init.arguments.0') as NodePath<t.StringLiteral>
    ).node.value;
  } else if (path.parentPath.isVariableDeclarator({ id: path.node })) {
    const init = path.parentPath.get('init');
    const suffix =
      (init.isExpression() && generateExpressionName(init, stable)) || '';
    return 'v' + titleCase(suffix);
  } else if (path.parentPath.isCatchClause()) {
    return 'e';
  } else if (path.parentPath.isArrayPattern()) {
    return 'v';
  } else {
    return null;
  }
}

function inferName(path: NodePath<t.Identifier>, stable: boolean): string {
  let scopeName = getScopeName(path, stable);
  if (scopeName === null) return path.node.name;
  if (stable) {
    const binding = path.scope.getBinding(path.node.name)!;
    scopeName += '_' + binding.referencePaths.length + '_';
    for (
      let parent: NodePath<t.Node> | null = path.parentPath;
      parent;
      parent = parent.parentPath
    ) {
      if (parent.isFunction() || parent.isClass()) {
        const name = generateExpressionName(
          parent as NodePath<t.Expression>,
          stable,
        );
        scopeName += name ? titleCase(name) : '';
      }
    }
  }
  return generateUid(path.scope, scopeName);
}

function generateExpressionName(
  expression: NodePath<t.Expression>,
  stable: boolean,
): string | undefined {
  if (expression.isIdentifier()) {
    return expression.node.name;
  } else if (expression.isFunctionExpression()) {
    return (
      (expression.node.id?.name ?? 'f') +
      (stable
        ? `_${expression.node.params.length}_${expression.node.body.body.length}`
        : '')
    );
  } else if (expression.isArrowFunctionExpression()) {
    return (
      'f' +
      (stable
        ? `_${expression.node.params.length}_${t.isExpression(expression.node.body) ? 1 : expression.node.body.body.length}`
        : '')
    );
  } else if (expression.isClassExpression()) {
    return expression.node.id?.name ?? 'C';
  } else if (expression.isCallExpression()) {
    return generateExpressionName(
      expression.get('callee') as NodePath<t.Expression>,
      stable,
    );
  } else if (expression.isThisExpression()) {
    return 'this';
  } else if (expression.isNumericLiteral()) {
    return 'LN' + expression.node.value.toString();
  } else if (expression.isStringLiteral()) {
    return 'LS' + titleCase(expression.node.value).slice(0, 20);
  } else if (expression.isObjectExpression()) {
    return 'O' + (stable ? `_${expression.node.properties.length}` : '');
  } else if (expression.isArrayExpression()) {
    return 'A' + (stable ? `_${expression.node.elements.length}` : '');
  } else if (expression.isBooleanLiteral()) {
    return 'L' + expression.node.value.toString();
  } else {
    return undefined;
  }
}

function titleCase(str: string) {
  return str
    .replace(/(?:^|\s)([a-z])/g, (_, m) => (m as string).toUpperCase())
    .replace(/[^a-zA-Z0-9$_]/g, '');
}
