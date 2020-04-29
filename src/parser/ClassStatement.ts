import { Token, Identifier } from '../lexer';
import { Statement } from './Statement';
import { FunctionExpression, CallExpression, VariableExpression, DottedGetExpression, NamespacedVariableNameExpression, Expression } from './Expression';
import { SourceNode } from 'source-map';
import { TranspileState } from './TranspileState';
import { Parser, ParseMode } from './Parser';
import { Range } from 'vscode-languageserver';
import util from '../util';

export class ClassStatement implements Statement {

    constructor(
        readonly classKeyword: Token,
        /**
         * The name of the class (without namespace prefix)
         */
        readonly name: Identifier,
        public body: Statement[],
        readonly end: Token,
        readonly extendsKeyword?: Token,
        readonly parentClassName?: NamespacedVariableNameExpression,
        readonly namespaceName?: NamespacedVariableNameExpression
    ) {
        this.body = this.body ?? [];
        for (let statement of this.body) {
            if (statement instanceof ClassMethodStatement) {
                this.methods.push(statement);
                this.memberMap[statement?.name?.text.toLowerCase()] = statement;
            } else if (statement instanceof ClassFieldStatement) {
                this.fields.push(statement);
                this.memberMap[statement?.name?.text.toLowerCase()] = statement;
            }
        }

        this.range = Range.create(this.classKeyword.range.start, this.end.range.end);
    }

    public getName(parseMode: ParseMode) {
        if (this.name && this.name.text) {
            if (this.namespaceName) {
                let namespaceName = this.namespaceName.getName(parseMode);
                let separator = parseMode === ParseMode.BrighterScript ? '.' : '_';
                return namespaceName + separator + this.name.text;
            } else {
                return this.name.text;
            }
        } else {
            //return undefined which will allow outside callers to know that this class doesn't have a name
            return undefined;
        }
    }

    public memberMap = {} as { [lowerMemberName: string]: ClassMemberStatement };
    public methods = [] as ClassMethodStatement[];
    public fields = [] as ClassFieldStatement[];


    public readonly range: Range;

    transpile(state: TranspileState): Array<SourceNode | string> {
        let result = [];
        //make the builder
        result.push(...this.getTranspiledBuilder(state));
        result.push(
            '\n',
            state.indent()
        );
        //make the class assembler (i.e. the public-facing class creator method)
        result.push(...this.getTranspiledClassFunction(state));
        return result;
    }

    /**
     * Find the parent index for this class's parent.
     * For class inheritance, every class is given an index.
     * The base class is index 0, its child is index 1, and so on.
     */
    public getParentClassIndex(state: TranspileState) {
        let myIndex = 0;
        let stmt = this as ClassStatement;
        while (stmt) {
            if (stmt.parentClassName) {
                stmt = state.file.getClassByName(stmt.parentClassName.getName(ParseMode.BrighterScript));
                myIndex++;
            } else {
                break;
            }
        }
        return myIndex - 1;
    }

    /**
     * Get all ancestor classes, in closest-to-furthest order (i.e. 0 is parent, 1 is grandparent, etc...).
     * This will return an empty array if no ancestors were found
     */
    public getAncestors(state: TranspileState) {
        let ancestors = [];
        let stmt = this as ClassStatement;
        while (stmt) {
            if (stmt.parentClassName) {
                stmt = state.file.getClassByName(stmt.parentClassName.getName(ParseMode.BrighterScript));
                ancestors.push(stmt);
            } else {
                break;
            }
        }
        return ancestors;
    }

    private getBuilderName(name: string) {
        return `__${name}_builder`;
    }

    /**
     * Get the constructor function for this class (if exists), or undefined if not exist
     */
    private getConstructorFunction() {
        for (let key in this.memberMap) {
            let member = this.memberMap[key];
            if (member.name?.text?.toLowerCase() === 'new') {
                return member as ClassMethodStatement;
            }
        }
    }
    private getEmptyNewFunction() {
        let stmt = (Parser.parse(`
            class UtilClass
                sub new()
                end sub
            end class
        `, { mode: ParseMode.BrighterScript }).statements[0] as ClassStatement).memberMap['new'] as ClassMethodStatement;
        //TODO make locations point to 0,0 (might not matter?)
        return stmt;
    }

    /**
     * Determine if the specified field was declared in one of the ancestor classes
     */
    private isFieldDeclaredByAncestor(fieldName: string, ancestors: ClassStatement[]) {
        let lowerFieldName = fieldName.toLowerCase();
        for (let ancestor of ancestors) {
            if (ancestor.memberMap[lowerFieldName]) {
                return true;
            }
        }
        return false;
    }

    /**
     * The builder is a function that assigns all of the methods and property names to a class instance.
     * This needs to be a separate function so that child classes can call the builder from their parent
     * without instantiating the parent constructor at that point in time.
     */
    private getTranspiledBuilder(state: TranspileState) {
        let result = [];
        result.push(`function ${this.getBuilderName(this.getName(ParseMode.BrightScript))}()\n`);
        state.blockDepth++;
        //indent
        result.push(state.indent());
        //create the instance
        result.push('instance = ');

        /**
         * The lineage of this class. index 0 is a direct parent, index 1 is index 0's parent, etc...
         */
        let ancestors = this.getAncestors(state);

        //construct parent class or empty object
        if (ancestors[0]) {
            let parentClassName = this.parentClassName.getName(ParseMode.BrightScript);
            result.push(this.getBuilderName(parentClassName), '()');
        } else {
            //use an empty object.
            result.push('{}');
        }
        result.push(
            state.newline(),
            state.indent()
        );
        let parentClassIndex = this.getParentClassIndex(state);

        //create empty `new` function if class is missing it (simplifies transpile logic)
        if (!this.getConstructorFunction()) {
            this.memberMap['new'] = this.getEmptyNewFunction();
            this.body = [this.memberMap['new'], ...this.body];
        }

        for (let statement of this.body) {
            //is field statement
            if (statement instanceof ClassFieldStatement) {
                //not declared in ancestor class
                if (!this.isFieldDeclaredByAncestor(statement.name.text, ancestors)) {
                    // add and initialize field to null
                    result.push(
                        `instance.${statement.name.text} = invalid`,
                        state.newline(),
                        state.indent()
                    );
                }
                //methods
            } else if (statement instanceof ClassMethodStatement) {

                //store overridden parent methods as super{parentIndex}_{methodName}
                if (
                    //is override method
                    statement.overrides ||
                    //is constructor function in child class
                    (statement.name.text.toLowerCase() === 'new' && ancestors[0])
                ) {
                    result.push(
                        `instance.super${parentClassIndex}_${statement.name.text} = instance.${statement.name.text}`,
                        state.newline(),
                        state.indent()
                    );
                }

                result.push(`instance.`);
                state.classStatement = this;
                result.push(
                    state.sourceNode(statement.name, statement.name.text),
                    ' = ',
                    ...statement.transpile(state),
                    state.newline(),
                    state.indent()
                );
                delete state.classStatement;
            } else {
                //other random statements (probably just comments)
                result.push(
                    ...statement.transpile(state),
                    state.indent()
                );
            }
        }
        //return the instance
        result.push('return instance\n');
        state.blockDepth--;
        result.push(state.indent());
        result.push(`end function`);
        return result;
    }

    /**
     * The class function is the function with the same name as the class. This is the function that
     * consumers should call to create a new instance of that class.
     * This invokes the builder, gets an instance of the class, then invokes the "new" function on that class.
     */
    private getTranspiledClassFunction(state: TranspileState) {
        let result = [];
        const constructorFunction = this.getConstructorFunction();
        const constructorParams = constructorFunction ? constructorFunction.func.parameters : [];

        result.push(`function ${this.getName(ParseMode.BrightScript)}(`);
        let i = 0;
        for (let param of constructorParams) {
            if (i > 0) {
                result.push(', ');
            }
            result.push(
                param.transpile(state)
            );
            i++;
        }
        result.push(
            ')',
            '\n'
        );

        state.blockDepth++;
        result.push(state.indent());
        result.push(`instance = ${this.getBuilderName(this.getName(ParseMode.BrightScript))}()\n`);

        result.push(state.indent());
        result.push(`instance.new(`);

        //append constructor arguments
        i = 0;
        for (let param of constructorParams) {
            if (i > 0) {
                result.push(', ');
            }
            result.push(
                state.sourceNode(param, param.name.text)
            );
            i++;
        }
        result.push(
            ')',
            '\n'
        );

        result.push(state.indent());
        result.push(`return instance\n`);

        state.blockDepth--;
        result.push(state.indent());
        result.push(`end function`);
        return result;
    }
}

export class ClassMethodStatement implements Statement {
    constructor(
        readonly accessModifier: Token,
        readonly name: Identifier,
        readonly func: FunctionExpression,
        readonly overrides: Token
    ) {
        this.range = Range.create(
            (this.accessModifier ?? this.func).range.start,
            this.func.range.end
        );
    }

    public readonly range: Range;

    transpile(state: TranspileState): Array<SourceNode | string> {
        //TODO - remove type information from these methods because that doesn't work
        //convert the `super` calls into the proper methods
        util.findAllDeep<any>(this.func.body.statements, (value) => {
            //if this is a method call
            if (value instanceof CallExpression) {
                let parentClassIndex = state.classStatement.getParentClassIndex(state);
                //this is the 'super()' call in the new method.
                if (value.callee instanceof VariableExpression && value.callee.name.text.toLowerCase() === 'super') {
                    value.callee.name.text = `m.super${parentClassIndex}_new`;

                    //this is a super.SomeMethod() call.
                } else if (value.callee instanceof DottedGetExpression) {
                    let beginningVariable = util.findBeginningVariableExpression(value.callee);
                    let lowerName = beginningVariable?.getName(ParseMode.BrighterScript).toLowerCase();
                    if (lowerName === 'super') {
                        beginningVariable.name.text = 'm';
                        value.callee.name.text = `super${parentClassIndex}_${value.callee.name.text}`;
                    }
                }
            }
            return false;
        });
        return this.func.transpile(state);
    }
}

export class ClassFieldStatement implements Statement {

    constructor(
        readonly accessModifier?: Token,
        readonly name?: Identifier,
        readonly as?: Token,
        readonly type?: Token,
        readonly equal?: Token,
        readonly initialValue?: Expression
    ) {
        this.range = Range.create(
            (this.accessModifier ?? this.name).range.start,
            (this.initialValue ?? this.type ?? this.as ?? this.name).range.end
        );
    }

    public readonly range: Range;

    transpile(state: TranspileState): Array<SourceNode | string> {
        throw new Error('transpile not implemented for ' + Object.getPrototypeOf(this).constructor.name);
    }
}
export type ClassMemberStatement = ClassFieldStatement | ClassMethodStatement;
