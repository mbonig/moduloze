"use strict";

var path = require("path");
var fs = require("fs");

var { default: traverse, } = require("@babel/traverse");
var T = require("@babel/types");
var { default: generate, } = require("@babel/generator");
var { parse, } = require("@babel/parser");

var UMDTemplate = fs.readFileSync(path.join(__dirname,"umd-template.js"),"utf-8");

var depMap = {
	"MyCoolModule": "test.js",
	"One": "1.js",
	"Two": "2.js",
	"Three": "3.js",
	"Four": "4.js",
	"Five": "5.js",
	"Six": "6.js",
	"Seven": "7.js",
	"Eight": "8.js",
	"Nine": "9.js",
	"Ten": "10.js",
	"Eleven": "11.js",
	"Twelve": "12.js",
	"Thirteen": "13.js",
	"Fourteen": "14.js",
	"Fifteen": "15.js",
	"Sixteen": "16.js",
	"Seventeen": "17.js",
	"Eighteen": "18.js",
	"Nineteen": "19.js",
};

var testJS = fs.readFileSync(path.join(__dirname,depMap["MyCoolModule"]),"utf-8");

buildUMD(
	depMap["MyCoolModule"],
	testJS,
	"MyCoolModule",
	depMap
);

console.log("");

buildESM("test.js",testJS);


// *****************************************


function buildUMD(codePath,code,moduleName,dependencyMap) {
	var { programAST, programPath, convertRequires, convertExports, } = identifyRequiresAndExports(codePath,code);

	var depEntries = Object.entries(dependencyMap);
	var deps = {};

	// convert all requires to UMD dependencies
	for (let req of convertRequires) {
		let specifierPath = req.specifier;

		// populate discovered-deps map
		let [ depName, depPath, ] = depEntries.find(
			([ depName, depPath, ]) => depPath == specifierPath
		) || [];
		if (depName) {
			if (!(depName in deps)) {
				deps[depName] = depPath;
			}
		}
		else if (req.umdType == "remove-require-unique") {
			depName = programPath.scope.generateUidIdentifier("imp").name;
			deps[depName] = specifierPath;
		}
		else {
			console.error(`Unknown UMD dependency: ${ specifierPath }`);
			return;
		}

		// process require() statements/expressions
		if (req.umdType == "remove-require-unique") {
			req.context.statement.remove();
		}
		else if (req.umdType == "default-require") {
			// variable declaration different name than registered dependency-name?
			if (depName != req.binding.target) {
				// replace require(..) call with registered dependency-name
				req.context.declarator.get("init").replaceWith(
					T.Identifier(depName)
				);
			}
			else {
				// remove whole declarator/statement
				req.context.declarator.remove();
			}
		}
		else if (req.umdType == "named-dependency") {
			req.context.declarator.get("init").replaceWith(
				T.MemberExpression(
					T.Identifier(depName),
					T.Identifier(req.binding.source)
				)
			);
		}
		else if (req.umdType == "destructured-dependency") {
			req.context.declarator.get("init").replaceWith(
				T.Identifier(depName)
			);
		}
		else if (req.umdType == "indirect-target") {
			req.context.statement.replaceWith(
				T.ExpressionStatement(
					T.AssignmentExpression(
						"=",
						T.Identifier(req.binding.target),
						T.Identifier(depName)
					)
				)
			);
		}
		else if (req.umdType == "indirect-source-target") {
			for (let binding of (Array.isArray(req.binding) ? req.binding : [req.binding,])) {
				req.context.statement.insertBefore(
					T.ExpressionStatement(
						T.AssignmentExpression(
							"=",
							T.Identifier(binding.target),
							T.MemberExpression(
								T.Identifier(depName),
								T.Identifier(binding.source)
							)
						)
					)
				);
			}
			req.context.statement.remove();
		}
	}

	// setup substitute module-exports target
	var $module$exports = programPath.scope.generateUidIdentifier("exp").name;
	programPath.get("body.0").insertBefore(
		T.VariableDeclaration(
			"var",
			[
				T.VariableDeclarator(T.Identifier($module$exports)),
			]
		)
	);
	programPath.get(`body.${ (programPath.node.body.length - 1) }`).insertAfter(
		T.ReturnStatement(T.Identifier($module$exports))
	);

	// convert all exports
	for (let expt of convertExports) {
		if (expt.umdType == "default-assignment") {
			expt.context.statement.get("expression.left").replaceWith(
				T.Identifier($module$exports)
			);
		}
		else if (expt.umdType == "named-export") {
			expt.context.statement.get("expression.left.object").replaceWith(
				T.Identifier($module$exports)
			);
		}
	}

	// construct UMD from template
	var umdAST = parse(UMDTemplate);
	traverse(umdAST,{
		Program: {
			exit(path) {
				var callExprPath = path.get("body.0.expression");

				// set module-name
				callExprPath.get("arguments.0").replaceWith(T.StringLiteral(moduleName));

				// set dependencies and named parameters
				var dependencies = Object.entries(deps);
				var funcPath = callExprPath.get("arguments.3");
				if (dependencies.length > 0) {
					let dependenciesPath = callExprPath.get("arguments.2");
					for (let [depName,depPath,] of dependencies) {
						// add dependency entry
						dependenciesPath.node.properties.push(
							T.ObjectProperty(
								T.StringLiteral(depName),
								T.StringLiteral(depPath)
							)
						);

						// add named parameter
						funcPath.node.params.push(T.Identifier(depName));
					}
				}
			},
		}
	});

	// add UMD wrapper to program
	var umdWrapper = T.clone(umdAST.program.body[0],/*deep=*/true,/*withoutLoc=*/true);
	programPath.unshiftContainer("body",umdWrapper);

	// get reference to UMD definition function
	var defFuncPath = programPath.get("body.0.expression.arguments.3.body");

	// add strict-mode directive to UMD definition function?
	if (
		programAST.program.directives.length > 0 &&
		programAST.program.directives[0].value.value == "use strict"
	) {
		defFuncPath.node.directives.push(
			T.Directive(T.DirectiveLiteral("use strict"))
		);
	}

	// move all the program's top-level statements into the UMD definition function
	while (programAST.program.body.length > 1) {
		let stmt = programPath.get(`body.1`);
		let newStmt = T.cloneDeep(stmt.node);
		defFuncPath.pushContainer("body",newStmt);
		stmt.remove();
	}

	console.log(generate(programAST).code);
}

function buildESM(codePath,code) {
	var { programAST, programPath, convertRequires, convertExports, } = identifyRequiresAndExports(codePath,code);

	// convert all requires to ESM imports
	for (let req of convertRequires) {
		if (req.esmType == "bare-import") {
			// replace with bare-import statement
			req.context.statement.replaceWith(
				T.ImportDeclaration([],T.StringLiteral(req.specifier))
			);
		}
		else if (req.esmType == "default-import") {
			// replace with default-import statement
			req.context.statement.replaceWith(
				T.ImportDeclaration(
					[
						T.ImportDefaultSpecifier(T.Identifier(req.binding.target)),
					],
					T.StringLiteral(req.specifier)
				)
			);
		}
		else if (req.esmType == "named-import") {
			// collect named bindings
			let importBindings = [];
			for (let binding of (Array.isArray(req.binding) ? req.binding : [ req.binding, ])) {
				importBindings.push(
					(binding.source == "default") ?
						T.ImportDefaultSpecifier(T.Identifier(binding.target)) :
						T.ImportSpecifier(
							T.Identifier(binding.target),
							T.Identifier(binding.source)
						)
				);
			}

			// replace with named-import statement
			req.context.statement.replaceWith(
				T.ImportDeclaration(importBindings,T.StringLiteral(req.specifier))
			);
		}
		else if (req.esmType == "default-import-indirect") {
			// replace with...
			req.context.statement.replaceWithMultiple([
				// ...default-import statement
				T.ImportDeclaration(
					[
						T.ImportDefaultSpecifier(T.Identifier(req.binding.uniqueTarget)),
					],
					T.StringLiteral(req.specifier)
				),
				// ...and indirect target assignment
				T.ExpressionStatement(
					T.AssignmentExpression(
						"=",
						T.Identifier(req.binding.target),
						T.Identifier(req.binding.uniqueTarget)
					)
				),
			]);
		}
		else if (req.esmType == "named-import-indirect") {
			// collect named bindings and indirect target assignments
			let importBindings = [];
			let assignments = [];
			for (let binding of (Array.isArray(req.binding) ? req.binding : [ req.binding, ])) {
				importBindings.push(
					(binding.source == "default") ?
						T.ImportDefaultSpecifier(T.Identifier(binding.uniqueTarget)) :
						T.ImportSpecifier(
							T.Identifier(binding.uniqueTarget),
							T.Identifier(binding.source)
						)
				);
				assignments.push(
					T.ExpressionStatement(
						T.AssignmentExpression(
							"=",
							T.Identifier(binding.target),
							T.Identifier(binding.uniqueTarget)
						)
					)
				);
			}

			// replace with named-import statement and assignments
			req.context.statement.replaceWithMultiple([
				T.ImportDeclaration(importBindings,T.StringLiteral(req.specifier)),
				...assignments
			]);
		}
	}

	// convert all exports
	for (let expt of convertExports) {
		if (expt.esmType == "default-export") {
			expt.context.statement.replaceWith(
				T.ExportDefaultDeclaration(expt.binding.source)
			);
		}
		else if (expt.esmType == "named-declaration-export") {
			expt.context.statement.replaceWithMultiple([
				T.VariableDeclaration(
					"let",
					[
						T.VariableDeclarator(
							T.Identifier(expt.binding.uniqueTarget),
							expt.binding.source
						),
					]
				),
				(expt.binding.target == "default") ?
					T.ExportDefaultDeclaration(T.Identifier(expt.binding.uniqueTarget)) :
					T.ExportNamedDeclaration(
						null,
						[
							T.ExportSpecifier(
								T.Identifier(expt.binding.uniqueTarget),
								T.Identifier(expt.binding.target)
							),
						]
					)
			]);
		}
		else if (expt.esmType == "named-export") {
			expt.context.statement.replaceWith(
				(expt.binding.target == "default") ?
					T.ExportDefaultDeclaration(expt.binding.source) :
					T.ExportNamedDeclaration(
						null,
						[
							T.ExportSpecifier(
								T.Identifier(expt.binding.source),
								T.Identifier(expt.binding.target)
							),
						]
					)
			);
		}
	}

	// remove any strict-mode directive (since ESM is automatically strict-mode)
	programAST.program.directives.length = 0;

	console.log(generate(programAST).code);
}

function identifyRequiresAndExports(codePath,code) {
	var programPath;
	var requireStatements = new Set();
	var exportStatements = new Set();
	var requireCalls = new WeakMap();
	var exportAssignments = new WeakMap();

	var visitors = {
		Program: {
			exit(path) {
				programPath = path;
			},
		},
		CallExpression: {
			exit(path) {
				// require(..) call?
				if (T.isIdentifier(path.node.callee,{ name: "require", })) {
					// require(" some string literal ") ?
					if (
						path.node.arguments.length == 1 &&
						T.isStringLiteral(path.node.arguments[0])
					) {
						let parentStatementPath = findParentStatement(path.parentPath);
						if (parentStatementPath) {
							requireStatements.add(parentStatementPath);
							if (!requireCalls.has(parentStatementPath)) {
								requireCalls.set(parentStatementPath,[]);
							}
							requireCalls.get(parentStatementPath).push(path);
						}
					}
					// non-string literals not supported
					else {
						console.error("Unsupported: require(..) statement without a single string-literal argument.");
					}
				}
			}
		},
		MemberExpression: {
			exit(path) {
				// module.exports?
				if (
					T.isIdentifier(path.node.object,{ name: "module", }) &&
					T.isIdentifier(path.node.property,{ name: "exports" })
				) {
					// used as a left-hand assignment target?
					if (isAssignmentTarget(path)) {
						let parentStatementPath = findParentStatement(path.parentPath);
						if (parentStatementPath) {
							exportStatements.add(parentStatementPath);
							if (!exportAssignments.has(parentStatementPath)) {
								exportAssignments.set(parentStatementPath,[]);
							}
							exportAssignments.get(parentStatementPath).push(path);
						}
					}
					else {
						console.error("Unsupported: module.exports not used as an assignment target.");
					}
				}
			}
		},
		Identifier: {
			exit(path) {
				// exports?
				if (
					path.node.name == "exports" &&
					// NOT x.exports form?
					// note: exports.x is totally allowed, but x.exports
					//   isn't an export form we care about
					!(
						T.isMemberExpression(path.parent) &&
						path.parent.property == path.node
					)
				) {
					// used as a left-hand assignment target?
					if (isAssignmentTarget(path)) {
						let parentStatementPath = findParentStatement(path.parentPath);
						if (parentStatementPath) {
							exportStatements.add(parentStatementPath);
							if (!exportAssignments.has(parentStatementPath)) {
								exportAssignments.set(parentStatementPath,[]);
							}
							exportAssignments.get(parentStatementPath).push(path);
						}
					}
					else {
						console.error("Unsupported: module.exports not used as an assignment target.");
					}
				}
			}
		}
	};

	var programAST = parse(code,{ sourceFilename: codePath, });
	traverse(programAST,visitors);
	var convertRequires = analyzeRequires(requireStatements,requireCalls);
	var convertExports = analyzeExports(exportStatements,exportAssignments);

	return {
		programAST,
		programPath,
		convertRequires,
		convertExports,
	};
}

function analyzeRequires(requireStatements,requireCalls) {
	var convertRequires = [];

	for (let stmt of requireStatements) {
		let stmtReqCalls = requireCalls.get(stmt);

		// standalone require(".."")?
		if (
			T.isExpressionStatement(stmt.node) &&
			T.isCallExpression(stmt.node.expression) &&
			stmtReqCalls.length == 1 &&
			stmtReqCalls[0].node == stmt.node.expression
		) {
			let call = stmt.node.expression;
			let specifier = call.arguments[0].extra.rawValue;

			// console.log(`import ${ specifier };`);
			convertRequires.push({
				esmType: "bare-import",
				umdType: "remove-require-unique",
				specifier,
				context: {
					statement: stmt,
				},
			});
			continue;
		}
		// var/let/const declaration statement?
		else if (T.isVariableDeclaration(stmt.node)) {
			for (let [declIdx,declNode,] of stmt.node.declarations.entries()) {
				let decl = stmt.get(`declarations.${ declIdx }`);

				// normal identifier declaration? var x = ..
				if (T.isIdentifier(declNode.id)) {
					// call as initialization assignment? var x = require("..")
					if (
						T.isCallExpression(declNode.init) &&
						stmtReqCalls.find(p => p.node == declNode.init)
					) {
						let call = declNode.init;
						let specifier = call.arguments[0].extra.rawValue;

						// console.log(`import * as ${ declNode.id.name } from ${ specifier };`);
						// console.log(`import ${ declNode.id.name } from ${ specifier };`);
						convertRequires.push({
							esmType: "default-import",
							umdType: "default-require",
							binding: {
								target: declNode.id.name
							},
							specifier,
							context: {
								statement: stmt,
								declarator: decl,
								declarationIdx: declIdx,
							},
						});
						continue;
					}
					else if (
						// require("..") is part of a simple member expression?
						T.isMemberExpression(declNode.init) &&
						stmtReqCalls.find(p => p.node == declNode.init.object) &&
						(
							// single property expression via . operator?
							// x = require("..").x
							T.isIdentifier(declNode.init.property) ||
							// single property expression via [".."] operator?
							T.isStringLiteral(declNode.init.property)
						)
					) {
						let call = declNode.init.object;
						let specifier = call.arguments[0].extra.rawValue;
						let target = declNode.id.name;
						let source =
							T.isIdentifier(declNode.init.property) ?
								declNode.init.property.name :
							T.isStringLiteral(declNode.init.property) ?
								declNode.init.property.value :
							undefined;
						if (source) {
							// console.log(`import { ${ binding } } from ${ specifier };`);
							convertRequires.push({
								esmType: "named-import",
								umdType: "named-dependency",
								binding: {
									source,
									target,
								},
								specifier,
								context: {
									statement: stmt,
									declarator: decl,
									declarationIdx: declIdx,
								},
							});
							continue;
						}
					}
					// otherwise, a variable declaration without a `require(..)` in it
					else {
						continue;
					}
				}
				// destructuring assignment? var { x } = require("..")
				else if (
					T.isObjectPattern(declNode.id) &&
					T.isCallExpression(declNode.init) &&
					stmtReqCalls.find(p => p.node == declNode.init)
				) {
					let call = declNode.init;
					let specifier = call.arguments[0].extra.rawValue;
					let pattern = declNode.id;
					let bindings = [];
					for (let targetProp of pattern.properties) {
						// simple destructuring target?
						if (
							!targetProp.computed &&
							T.isIdentifier(targetProp.value)
						) {
							let source =
								T.isIdentifier(targetProp.key) ? targetProp.key.name :
								T.isStringLiteral(targetProp.key) ? targetProp.key.value :
								undefined;
							if (source) {
								bindings.push({
									source,
									target: targetProp.value.name,
								});
								continue;
							}
						}

						// if we get here, the `require(..)` wasn't of a supported form
						console.error("Unsupported: destructuring pattern not ESM import-compatible");
					}

					if (bindings.length > 0) {
						// console.log(`import { ${ binding } } from ${ specifier };`);
						convertRequires.push({
							esmType: "named-import",
							umdType: "destructured-dependency",
							binding: bindings,
							specifier,
							context: {
								statement: stmt,
								declarator: decl,
								declarationIdx: declIdx,
							},
						});
						continue;
					}
				}

				// if we get here, the `require(..)` wasn't of a supported form
				console.error("Unsupported: variable declaration not ESM import-compatible");
			}

			continue;
		}
		// non-declaration assignment statement?
		else if (
			T.isExpressionStatement(stmt.node) &&
			T.isAssignmentExpression(stmt.node.expression)
		) {
			let assignment = stmt.node.expression;

			// regular identifier assignment? x = ..
			if (T.isIdentifier(assignment.left)) {
				// simple call assignment? x = require("..")
				if (stmtReqCalls.find(p => p.node == assignment.right)) {
					let call = assignment.right;
					let specifier = call.arguments[0].extra.rawValue;
					let target = assignment.left.name;

					// console.log(`import * as ${ target$1 } from ${ specifier }; ${ target } = ${ target$1 };`);
					// console.log(`import ${ target$1 } from ${ specifier }; ${ target } = ${ target$1 };`);
					convertRequires.push({
						esmType: "default-import-indirect",
						umdType: "indirect-target",
						binding: {
							target,
							uniqueTarget: stmt.scope.generateUidIdentifier("imp").name,
						},
						specifier,
						context: {
							statement: stmt,
						},
					});
					continue;
				}
				else if (
					// require("..") part of a simple member expression?
					T.isMemberExpression(assignment.right) &&
					stmtReqCalls.find(p => p.node == assignment.right.object) &&
					(
						// single property expression via . operator?
						// x = require("..").x
						T.isIdentifier(assignment.right.property) ||
						// single property expression via [".."] operator?
						// x = require("..")[".."]
						T.isStringLiteral(assignment.right.property)
					)
				) {
					let call = assignment.right.object;
					let specifier = call.arguments[0].extra.rawValue;
					let target = assignment.left.name;
					let source =
						T.isIdentifier(assignment.right.property) ?
							assignment.right.property.name :
						T.isStringLiteral(assignment.right.property) ?
							assignment.right.property.value :
						undefined;
					if (source) {
						// console.log(`import { ${ binding } } from ${ specifier }; ${ target } = ${ target$1 };`);
						convertRequires.push({
							esmType: "named-import-indirect",
							umdType: "indirect-source-target",
							binding: {
								source,
								target,
								uniqueTarget: stmt.scope.generateUidIdentifier("imp").name,
							},
							specifier,
							context: {
								statement: stmt,
							},
						});
						continue;
					}
				}
			}
			// destructuring assignment? { x } = require("..")
			else if (
				T.isObjectPattern(assignment.left) &&
				stmtReqCalls.find(p => p.node == assignment.right)
			) {
				let call = assignment.right;
				let specifier = call.arguments[0].extra.rawValue;
				let pattern = assignment.left;
				let bindings = [];
				for (let targetProp of pattern.properties) {
					// simple destructuring target?
					if (
						!targetProp.computed &&
						T.isIdentifier(targetProp.value)
					) {
						let source =
							T.isIdentifier(targetProp.key) ? targetProp.key.name :
							T.isStringLiteral(targetProp.key) ? targetProp.key.value :
							undefined;
						if (source) {
							bindings.push({
								source,
								target: targetProp.value.name,
								uniqueTarget: stmt.scope.generateUidIdentifier("imp").name,
							});
							continue;
						}
					}

					// if we get here, the `require(..)` wasn't of a supported form
					console.error("Unsupported: destructuring pattern not ESM import-compatible");
				}

				if (bindings.length > 0) {
					// console.log(`import { ${ binding } } from ${ specifier }; ${ target } = ${ target$1 };`);
					convertRequires.push({
						esmType: "named-import-indirect",
						umdType: "indirect-source-target",
						binding: bindings,
						specifier,
						context: {
							statement: stmt,
						},
					});
					continue;
				}
			}
		}

		// if we get here, the `require(..)` wasn't of a supported form
		console.error("Unsupported: require(..) statement not ESM import-compatible");
	}

	return convertRequires;
}

function analyzeExports(exportStatements,exportAssignments) {
	var convertExports = [];

	for (let stmt of exportStatements) {
		let stmtExpAssignments = exportAssignments.get(stmt);

		// single export assignment?
		if (
			T.isExpressionStatement(stmt.node) &&
			T.isAssignmentExpression(stmt.node.expression) &&
			stmtExpAssignments.length == 1
		) {
			let assg = stmt.node.expression;
			let target = assg.left;
			let source = assg.right;

			if (target == stmtExpAssignments[0].node) {
				if (
					T.isIdentifier(target,{ name: "exports", }) ||
					(
						T.isMemberExpression(target) &&
						T.isIdentifier(target.object,{ name: "module", }) &&
						T.isIdentifier(target.property,{ name: "exports", })
					)
				) {
					// exporting an identifier?
					if (
						T.isIdentifier(source) &&
						source.name != "undefined"
					) {
						// console.log(`export default ${ source.name };`);
						convertExports.push({
							esmType: "default-export",
							umdType: "default-assignment",
							binding: {
								source,
							},
							context: {
								statement: stmt,
							},
						});
						continue;
					}
					// exporting any other value/expression
					else {
						// console.log("export default ..;");
						convertExports.push({
							esmType: "default-export",
							umdType: "default-assignment",
							binding: {
								source,
							},
							context: {
								statement: stmt,
							},
						});
						continue;
					}
				}
			}
			else if (T.isMemberExpression(target,{ object: stmtExpAssignments[0].node, })) {
				let exportName =
					T.isIdentifier(target.property) ? target.property.name :
					T.isStringLiteral(target.property) ? target.property.value :
					undefined;
				target = target.object;

				if (
					T.isIdentifier(target,{ name: "exports", }) ||
					(
						T.isMemberExpression(target) &&
						T.isIdentifier(target.object,{ name: "module", }) &&
						T.isIdentifier(target.property,{ name: "exports", })
					)
				) {
					// exporting an identifier?
					if (
						T.isIdentifier(source) &&
						source.name != "undefined"
					) {
						// console.log(`export { ${ source.name } as ${ exportName } };`);
						convertExports.push({
							esmType: "named-export",
							umdType: "named-export",
							binding: {
								source: source.name,
								target: exportName,
							},
							context: {
								statement: stmt,
							},
						});
						continue;
					}
					// exporting any other value/expression
					else {
						// console.log(`var ${ exportName }$1 = ..; export { ${exportName}$1 as ${ exportName } };`);
						convertExports.push({
							esmType: "named-declaration-export",
							umdType: "named-export",
							binding: {
								source,
								target: exportName,
								uniqueTarget: stmt.scope.generateUidIdentifier("exp").name,
							},
							context: {
								statement: stmt,
							},
						});
						continue;
					}
				}
			}
		}

		// if we get here, the exports/module.exports wasn't of a supported form
		console.error("Unsupported: exports expression not ESM export-compatible");
	}

	return convertExports;
}

function exportPrimitiveLiteralValue(node) {
	if (T.isStringLiteral(node)) {
		return node.extra.raw;
	}
	else if (T.isIdentifier(node,{ name: "undefined", })) {
		return "undefined";
	}
	else if (T.isNullLiteral(node)) {
		return "null";
	}
	else if (
		T.isNumericLiteral(node) ||
		T.isBooleanLiteral(node)
	) {
		return String(node.value);
	}
}

function findParentStatement(path) {
	if (T.isProgram(path)) {
		return null;
	}
	else if (T.isStatement(path)) {
		return path;
	}
	else {
		return findParentStatement(path.parentPath);
	}
}

function isAssignmentTarget(path) {
	if (
		T.isProgram(path.node) ||
		T.isStatement(path.node) ||
		T.isAssignmentPattern(path.node)
	) {
		return false;
	}
	else if (T.isAssignmentExpression(path.parent)) {
		return (path.parent.left == path.node);
	}
	else {
		return isAssignmentTarget(path.parentPath);
	}
}
