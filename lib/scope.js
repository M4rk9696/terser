/***********************************************************************

  A JavaScript tokenizer / parser / beautifier / compressor.
  https://github.com/mishoo/UglifyJS2

  -------------------------------- (C) ---------------------------------

                           Author: Mihai Bazon
                         <mihai.bazon@gmail.com>
                       http://mihai.bazon.net/blog

  Distributed under the BSD license:

    Copyright 2012 (c) Mihai Bazon <mihai.bazon@gmail.com>

    Redistribution and use in source and binary forms, with or without
    modification, are permitted provided that the following conditions
    are met:

        * Redistributions of source code must retain the above
          copyright notice, this list of conditions and the following
          disclaimer.

        * Redistributions in binary form must reproduce the above
          copyright notice, this list of conditions and the following
          disclaimer in the documentation and/or other materials
          provided with the distribution.

    THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDER “AS IS” AND ANY
    EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
    IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
    PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER BE
    LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY,
    OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
    PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
    PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
    THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR
    TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF
    THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF
    SUCH DAMAGE.

 ***********************************************************************/

"use strict";

import {
    defaults,
    keep_name,
    member,
    mergeSort,
    push_uniq,
    return_false,
    return_this,
    return_true,
    string_template,
} from "./utils/index.js";
import {
    AST_Arrow,
    AST_Block,
    AST_Call,
    AST_Catch,
    AST_Class,
    AST_Conditional,
    AST_DefClass,
    AST_Defun,
    AST_Destructuring,
    AST_Dot,
    AST_Export,
    AST_For,
    AST_ForIn,
    AST_Function,
    AST_Import,
    AST_IterationStatement,
    AST_Label,
    AST_LabeledStatement,
    AST_LabelRef,
    AST_Lambda,
    AST_LoopControl,
    AST_NameMapping,
    AST_Node,
    AST_Scope,
    AST_Sequence,
    AST_String,
    AST_Sub,
    AST_Switch,
    AST_SwitchBranch,
    AST_Symbol,
    AST_SymbolBlockDeclaration,
    AST_SymbolCatch,
    AST_SymbolClass,
    AST_SymbolConst,
    AST_SymbolDefClass,
    AST_SymbolDefun,
    AST_SymbolExport,
    AST_SymbolFunarg,
    AST_SymbolImport,
    AST_SymbolLambda,
    AST_SymbolLet,
    AST_SymbolMethod,
    AST_SymbolRef,
    AST_SymbolVar,
    AST_Toplevel,
    AST_VarDef,
    AST_With,
    TreeWalker,
} from "./ast.js";
import {
    RESERVED_WORDS,
    js_error,
} from "./parse.js";

const MASK_EXPORT_DONT_MANGLE = 1 << 0;
const MASK_EXPORT_WANT_MANGLE = 1 << 1;

let function_defs = null;

class SymbolDef {
    constructor(scope, orig, init) {
        this.name = orig.name;
        this.orig = [ orig ];
        this.init = init;
        this.eliminated = 0;
        this.assignments = 0;
        this.scope = scope;
        this.references = [];
        this.replaced = 0;
        this.global = false;
        this.export = 0;
        this.mangled_name = null;
        this.undeclared = false;
        this.id = SymbolDef.next_id++;
        this.chained = false;
        this.direct_access = false;
        this.escaped = 0;
        this.recursive_refs = 0;
        this.references = [];
        this.should_replace = undefined;
        this.single_use = false;
        this.fixed = false;
        Object.seal(this);
    }
    unmangleable(options) {
        if (!options) options = {};

        if (
            function_defs &&
            function_defs.has(this.id) &&
            keep_name(options.keep_fnames, this.orig[0].name)
        ) return true;

        return this.global && !options.toplevel
            || (this.export & MASK_EXPORT_DONT_MANGLE)
            || this.undeclared
            || !options.eval && this.scope.pinned()
            || (this.orig[0] instanceof AST_SymbolLambda
                  || this.orig[0] instanceof AST_SymbolDefun) && keep_name(options.keep_fnames, this.orig[0].name)
            || this.orig[0] instanceof AST_SymbolMethod
            || (this.orig[0] instanceof AST_SymbolClass
                  || this.orig[0] instanceof AST_SymbolDefClass) && keep_name(options.keep_classnames, this.orig[0].name);
    }
    mangle(options) {
        const cache = options.cache && options.cache.props;
        if (this.global && cache && cache.has(this.name)) {
            this.mangled_name = cache.get(this.name);
        } else if (!this.mangled_name && !this.unmangleable(options)) {
            var s = this.scope;
            var sym = this.orig[0];
            if (options.ie8 && sym instanceof AST_SymbolLambda)
                s = s.parent_scope;
            const redefinition = redefined_catch_def(this);
            this.mangled_name = redefinition
                ? redefinition.mangled_name || redefinition.name
                : s.next_mangled(options, this);
            if (this.global && cache) {
                cache.set(this.name, this.mangled_name);
            }
        }
    }
}

SymbolDef.next_id = 1;

function redefined_catch_def(def) {
    if (def.orig[0] instanceof AST_SymbolCatch
        && def.scope.is_block_scope()
    ) {
        return def.scope.get_defun_scope().variables.get(def.name);
    }
}

AST_Toplevel.DEFMETHOD("figure_out_scope", function(options) {
    options = defaults(options, {
        cache: null,
        ie8: false,
        safari10: false,
    });

    // pass 1: setup scope chaining and handle definitions
    var self = this;
    var scope = self.parent_scope = null;
    var labels = new Map();
    var defun = null;
    var in_destructuring = null;
    var for_scopes = [];
    var tw = new TreeWalker(function(node, descend) {
        if (node.is_block_scope()) {
            const save_scope = scope;
            node.block_scope = scope = new AST_Scope(node);
            // AST_Try in the AST sadly *is* (not has) a body itself,
            // and its catch and finally branches are children of the AST_Try itself
            const parent_scope = node instanceof AST_Catch
                ? save_scope.parent_scope
                : save_scope;
            scope.init_scope_vars(parent_scope);
            scope.uses_with = save_scope.uses_with;
            scope.uses_eval = save_scope.uses_eval;
            if (options.safari10) {
                if (node instanceof AST_For || node instanceof AST_ForIn) {
                    for_scopes.push(scope);
                }
            }

            if (node instanceof AST_Switch) {
                // XXX: HACK! Ensure the switch expression gets the correct scope (the parent scope) and the body gets the contained scope
                // AST_Switch has a scope within the body, but it itself "is a block scope"
                // This means the switched expression has to belong to the outer scope
                // while the body inside belongs to the switch itself.
                // This is pretty nasty and warrants an AST change similar to AST_Try (read above)
                const the_block_scope = scope;
                scope = save_scope;
                node.expression.walk(tw);
                scope = the_block_scope;
                for (let i = 0; i < node.body.length; i++) {
                    node.body[i].walk(tw);
                }
            } else {
                descend();
            }
            scope = save_scope;
            return true;
        }
        if (node instanceof AST_Destructuring) {
            const save_destructuring = in_destructuring;
            in_destructuring = node;
            descend();
            in_destructuring = save_destructuring;
            return true;
        }
        if (node instanceof AST_Scope) {
            node.init_scope_vars(scope);
            var save_scope = scope;
            var save_defun = defun;
            var save_labels = labels;
            defun = scope = node;
            labels = new Map();
            descend();
            scope = save_scope;
            defun = save_defun;
            labels = save_labels;
            return true;        // don't descend again in TreeWalker
        }
        if (node instanceof AST_LabeledStatement) {
            var l = node.label;
            if (labels.has(l.name)) {
                throw new Error(string_template("Label {name} defined twice", l));
            }
            labels.set(l.name, l);
            descend();
            labels.delete(l.name);
            return true;        // no descend again
        }
        if (node instanceof AST_With) {
            for (var s = scope; s; s = s.parent_scope)
                s.uses_with = true;
            return;
        }
        if (node instanceof AST_Symbol) {
            node.scope = scope;
        }
        if (node instanceof AST_Label) {
            node.thedef = node;
            node.references = [];
        }
        if (node instanceof AST_SymbolLambda) {
            defun.def_function(node, node.name == "arguments" ? undefined : defun);
        } else if (node instanceof AST_SymbolDefun) {
            // Careful here, the scope where this should be defined is
            // the parent scope.  The reason is that we enter a new
            // scope when we encounter the AST_Defun node (which is
            // instanceof AST_Scope) but we get to the symbol a bit
            // later.
            mark_export((node.scope = defun.parent_scope.get_defun_scope()).def_function(node, defun), 1);
        } else if (node instanceof AST_SymbolClass) {
            mark_export(defun.def_variable(node, defun), 1);
        } else if (node instanceof AST_SymbolImport) {
            scope.def_variable(node);
        } else if (node instanceof AST_SymbolDefClass) {
            // This deals with the name of the class being available
            // inside the class.
            mark_export((node.scope = defun.parent_scope).def_function(node, defun), 1);
        } else if (
            node instanceof AST_SymbolVar
            || node instanceof AST_SymbolLet
            || node instanceof AST_SymbolConst
            || node instanceof AST_SymbolCatch
        ) {
            var def;
            if (node instanceof AST_SymbolBlockDeclaration) {
                def = scope.def_variable(node, null);
            } else {
                def = defun.def_variable(node, node.TYPE == "SymbolVar" ? null : undefined);
            }
            if (!def.orig.every((sym) => {
                if (sym === node) return true;
                if (node instanceof AST_SymbolBlockDeclaration) {
                    return sym instanceof AST_SymbolLambda;
                }
                return !(sym instanceof AST_SymbolLet || sym instanceof AST_SymbolConst);
            })) {
                js_error(
                    `"${node.name}" is redeclared`,
                    node.start.file,
                    node.start.line,
                    node.start.col,
                    node.start.pos
                );
            }
            if (!(node instanceof AST_SymbolFunarg)) mark_export(def, 2);
            if (defun !== scope) {
                node.mark_enclosed(options);
                var def = scope.find_variable(node);
                if (node.thedef !== def) {
                    node.thedef = def;
                    node.reference(options);
                }
            }
        } else if (node instanceof AST_LabelRef) {
            var sym = labels.get(node.name);
            if (!sym) throw new Error(string_template("Undefined label {name} [{line},{col}]", {
                name: node.name,
                line: node.start.line,
                col: node.start.col
            }));
            node.thedef = sym;
        }
        if (!(scope instanceof AST_Toplevel) && (node instanceof AST_Export || node instanceof AST_Import)) {
            js_error(
                `"${node.TYPE}" statement may only appear at the top level`,
                node.start.file,
                node.start.line,
                node.start.col,
                node.start.pos
            );
        }

        function mark_export(def, level) {
            if (in_destructuring) {
                var i = 0;
                do {
                    level++;
                } while (tw.parent(i++) !== in_destructuring);
            }
            var node = tw.parent(level);
            if (def.export = node instanceof AST_Export ? MASK_EXPORT_DONT_MANGLE : 0) {
                var exported = node.exported_definition;
                if ((exported instanceof AST_Defun || exported instanceof AST_DefClass) && node.is_default) {
                    def.export = MASK_EXPORT_WANT_MANGLE;
                }
            }
        }
    });
    self.walk(tw);

    // pass 2: find back references and eval
    self.globals = new Map();
    var tw = new TreeWalker(function(node, descend) {
        if (node instanceof AST_LoopControl && node.label) {
            node.label.thedef.references.push(node);
            return true;
        }
        if (node instanceof AST_SymbolRef) {
            var name = node.name;
            if (name == "eval" && tw.parent() instanceof AST_Call) {
                for (var s = node.scope; s && !s.uses_eval; s = s.parent_scope) {
                    s.uses_eval = true;
                }
            }
            var sym;
            if (tw.parent() instanceof AST_NameMapping && tw.parent(1).module_name
                || !(sym = node.scope.find_variable(name))) {
                sym = self.def_global(node);
                if (node instanceof AST_SymbolExport) sym.export = MASK_EXPORT_DONT_MANGLE;
            } else if (sym.scope instanceof AST_Lambda && name == "arguments") {
                sym.scope.uses_arguments = true;
            }
            node.thedef = sym;
            node.reference(options);
            if (node.scope.is_block_scope()
                && !(sym.orig[0] instanceof AST_SymbolBlockDeclaration)) {
                node.scope = node.scope.get_defun_scope();
            }
            return true;
        }
        // ensure mangling works if catch reuses a scope variable
        var def;
        if (node instanceof AST_SymbolCatch && (def = redefined_catch_def(node.definition()))) {
            var s = node.scope;
            while (s) {
                push_uniq(s.enclosed, def);
                if (s === def.scope) break;
                s = s.parent_scope;
            }
        }
    });
    self.walk(tw);

    // pass 3: work around IE8 and Safari catch scope bugs
    if (options.ie8 || options.safari10) {
        self.walk(new TreeWalker(function(node, descend) {
            if (node instanceof AST_SymbolCatch) {
                var name = node.name;
                var refs = node.thedef.references;
                var scope = node.scope.get_defun_scope();
                var def = scope.find_variable(name) || self.globals.get(name) || scope.def_variable(node);
                refs.forEach(function(ref) {
                    ref.thedef = def;
                    ref.reference(options);
                });
                node.thedef = def;
                node.reference(options);
                return true;
            }
        }));
    }

    // pass 4: add symbol definitions to loop scopes
    // Safari/Webkit bug workaround - loop init let variable shadowing argument.
    // https://github.com/mishoo/UglifyJS2/issues/1753
    // https://bugs.webkit.org/show_bug.cgi?id=171041
    if (options.safari10) {
        for (const scope of for_scopes) {
            scope.parent_scope.variables.forEach(function(def) {
                push_uniq(scope.enclosed, def);
            });
        }
    }
});

AST_Toplevel.DEFMETHOD("def_global", function(node) {
    var globals = this.globals, name = node.name;
    if (globals.has(name)) {
        return globals.get(name);
    } else {
        var g = new SymbolDef(this, node);
        g.undeclared = true;
        g.global = true;
        globals.set(name, g);
        return g;
    }
});

AST_Scope.DEFMETHOD("init_scope_vars", function(parent_scope) {
    this.variables = new Map();         // map name to AST_SymbolVar (variables defined in this scope; includes functions)
    this.functions = new Map();         // map name to AST_SymbolDefun (functions defined in this scope)
    this.uses_with = false;             // will be set to true if this or some nested scope uses the `with` statement
    this.uses_eval = false;             // will be set to true if this or nested scope uses the global `eval`
    this.parent_scope = parent_scope;   // the parent scope
    this.enclosed = [];                 // a list of variables from this or outer scope(s) that are referenced from this or inner scopes
    this.cname = -1;                    // the current index for mangling functions/variables
    this._var_name_cache = null;
});

AST_Scope.DEFMETHOD("var_names", function varNames() {
    var var_names = this._var_name_cache;
    if (!var_names) {
        this._var_name_cache = var_names = new Set(
            this.parent_scope ? varNames.call(this.parent_scope) : null
        );
        if (this._added_var_names) {
            this._added_var_names.forEach(name => { var_names.add(name); });
        }
        this.enclosed.forEach(function(def) {
            var_names.add(def.name);
        });
        this.variables.forEach(function(def, name) {
            var_names.add(name);
        });
    }
    return var_names;
});

AST_Scope.DEFMETHOD("add_var_name", function (name) {
    // TODO change enclosed too
    if (!this._added_var_names) {
        // TODO stop adding var names entirely
        this._added_var_names = new Set();
    }
    this._added_var_names.add(name);
    if (!this._var_name_cache) this.var_names();  // regen cache
    this._var_name_cache.add(name);
});

// TODO create function that asks if we can inline

AST_Scope.DEFMETHOD("add_child_scope", function (scope) {
    // `scope` is going to be moved into wherever the compressor is
    // right now. Update the required scopes' information

    if (scope.parent_scope === this) return;

    scope.parent_scope = this;
    scope._var_name_cache = null;
    if (scope._added_var_names) {
        scope._added_var_names.forEach(name => scope.add_var_name(name));
    }

    // TODO uses_with, uses_eval, etc

    const new_scope_enclosed_set = new Set(scope.enclosed);
    const scope_ancestry = (() => {
        const ancestry = [];
        let cur = this;
        do {
            ancestry.push(cur);
        } while ((cur = cur.parent_scope));
        ancestry.reverse();
        return ancestry;
    })();

    const to_enclose = [];
    for (const scope_topdown of scope_ancestry) {
        to_enclose.forEach(e => push_uniq(scope_topdown.enclosed, e));
        for (const def of scope_topdown.variables.values()) {
            if (new_scope_enclosed_set.has(def)) {
                push_uniq(to_enclose, def);
                push_uniq(scope_topdown.enclosed, def);
            }
        }
    }
});

AST_Node.DEFMETHOD("is_block_scope", return_false);
AST_Class.DEFMETHOD("is_block_scope", return_false);
AST_Lambda.DEFMETHOD("is_block_scope", return_false);
AST_Toplevel.DEFMETHOD("is_block_scope", return_false);
AST_SwitchBranch.DEFMETHOD("is_block_scope", return_false);
AST_Block.DEFMETHOD("is_block_scope", return_true);
AST_IterationStatement.DEFMETHOD("is_block_scope", return_true);

AST_Lambda.DEFMETHOD("init_scope_vars", function() {
    AST_Scope.prototype.init_scope_vars.apply(this, arguments);
    this.uses_arguments = false;
    this.def_variable(new AST_SymbolFunarg({
        name: "arguments",
        start: this.start,
        end: this.end
    }));
});

AST_Arrow.DEFMETHOD("init_scope_vars", function() {
    AST_Scope.prototype.init_scope_vars.apply(this, arguments);
    this.uses_arguments = false;
});

AST_Symbol.DEFMETHOD("mark_enclosed", function(options) {
    var def = this.definition();
    var s = this.scope;
    while (s) {
        push_uniq(s.enclosed, def);
        if (options.keep_fnames) {
            s.functions.forEach(function(d) {
                if (keep_name(options.keep_fnames, d.name)) {
                    push_uniq(def.scope.enclosed, d);
                }
            });
        }
        if (s === def.scope) break;
        s = s.parent_scope;
    }
});

AST_Symbol.DEFMETHOD("reference", function(options) {
    this.definition().references.push(this);
    this.mark_enclosed(options);
});

AST_Scope.DEFMETHOD("find_variable", function(name) {
    if (name instanceof AST_Symbol) name = name.name;
    return this.variables.get(name)
        || (this.parent_scope && this.parent_scope.find_variable(name));
});

AST_Scope.DEFMETHOD("def_function", function(symbol, init) {
    var def = this.def_variable(symbol, init);
    if (!def.init || def.init instanceof AST_Defun) def.init = init;
    this.functions.set(symbol.name, def);
    return def;
});

AST_Scope.DEFMETHOD("def_variable", function(symbol, init) {
    var def = this.variables.get(symbol.name);
    if (def) {
        def.orig.push(symbol);
        if (def.init && (def.scope !== symbol.scope || def.init instanceof AST_Function)) {
            def.init = init;
        }
    } else {
        def = new SymbolDef(this, symbol, init);
        this.variables.set(symbol.name, def);
        def.global = !this.parent_scope;
    }
    return symbol.thedef = def;
});

function next_mangled(scope, options) {
    var ext = scope.enclosed;
    out: while (true) {
        var m = base54(++scope.cname);
        if (RESERVED_WORDS.has(m)) continue; // skip over "do"

        // https://github.com/mishoo/UglifyJS2/issues/242 -- do not
        // shadow a name reserved from mangling.
        if (options.reserved.has(m)) continue;

        // we must ensure that the mangled name does not shadow a name
        // from some parent scope that is referenced in this or in
        // inner scopes.
        for (var i = ext.length; --i >= 0;) {
            var sym = ext[i];
            var name = sym.mangled_name || (sym.unmangleable(options) && sym.name);
            if (m == name) continue out;
        }
        return m;
    }
}

AST_Scope.DEFMETHOD("next_mangled", function(options) {
    return next_mangled(this, options);
});

AST_Toplevel.DEFMETHOD("next_mangled", function(options) {
    let name;
    const mangled_names = this.mangled_names;
    do {
        name = next_mangled(this, options);
    } while (mangled_names.has(name));
    return name;
});

AST_Function.DEFMETHOD("next_mangled", function(options, def) {
    // #179, #326
    // in Safari strict mode, something like (function x(x){...}) is a syntax error;
    // a function expression's argument cannot shadow the function expression's name

    var tricky_def = def.orig[0] instanceof AST_SymbolFunarg && this.name && this.name.definition();

    // the function's mangled_name is null when keep_fnames is true
    var tricky_name = tricky_def ? tricky_def.mangled_name || tricky_def.name : null;

    while (true) {
        var name = next_mangled(this, options);
        if (!tricky_name || tricky_name != name)
            return name;
    }
});

AST_Symbol.DEFMETHOD("unmangleable", function(options) {
    var def = this.definition();
    return !def || def.unmangleable(options);
});

// labels are always mangleable
AST_Label.DEFMETHOD("unmangleable", return_false);

AST_Symbol.DEFMETHOD("unreferenced", function() {
    return !this.definition().references.length && !this.scope.pinned();
});

AST_Symbol.DEFMETHOD("definition", function() {
    return this.thedef;
});

AST_Symbol.DEFMETHOD("global", function() {
    return this.thedef.global;
});

AST_Toplevel.DEFMETHOD("_default_mangler_options", function(options) {
    options = defaults(options, {
        eval        : false,
        ie8         : false,
        keep_classnames: false,
        keep_fnames : false,
        module      : false,
        reserved    : [],
        toplevel    : false,
    });
    if (options.module) options.toplevel = true;
    if (!Array.isArray(options.reserved)
        && !(options.reserved instanceof Set)
    ) {
        options.reserved = [];
    }
    options.reserved = new Set(options.reserved);
    // Never mangle arguments
    options.reserved.add("arguments");
    return options;
});

AST_Toplevel.DEFMETHOD("mangle_names", function(options) {
    options = this._default_mangler_options(options);

    // We only need to mangle declaration nodes.  Special logic wired
    // into the code generator will display the mangled name if it's
    // present (and for AST_SymbolRef-s it'll use the mangled name of
    // the AST_SymbolDeclaration that it points to).
    var lname = -1;
    var to_mangle = [];

    if (options.keep_fnames) function_defs = new Set();

    const mangled_names = this.mangled_names = new Set();
    if (options.cache) {
        this.globals.forEach(collect);
        if (options.cache.props) {
            options.cache.props.forEach(function(mangled_name) {
                mangled_names.add(mangled_name);
            });
        }
    }

    var tw = new TreeWalker(function(node, descend) {
        if (node instanceof AST_LabeledStatement) {
            // lname is incremented when we get to the AST_Label
            var save_nesting = lname;
            descend();
            lname = save_nesting;
            return true;        // don't descend again in TreeWalker
        }
        if (node instanceof AST_Scope) {
            node.variables.forEach(collect);
            return;
        }
        if (node.is_block_scope()) {
            node.block_scope.variables.forEach(collect);
            return;
        }
        if (
            function_defs
            && node instanceof AST_VarDef
            && node.value instanceof AST_Lambda
            && !node.value.name
            && keep_name(options.keep_fnames, node.name.name)
        ) {
            function_defs.add(node.name.definition().id);
            return;
        }
        if (node instanceof AST_Label) {
            let name;
            do {
                name = base54(++lname);
            } while (RESERVED_WORDS.has(name));
            node.mangled_name = name;
            return true;
        }
        if (!(options.ie8 || options.safari10) && node instanceof AST_SymbolCatch) {
            to_mangle.push(node.definition());
            return;
        }
    });

    this.walk(tw);

    to_mangle.forEach(def => { def.mangle(options); });

    function_defs = null;

    function collect(symbol) {
        const should_mangle = !options.reserved.has(symbol.name)
            && !(symbol.export & MASK_EXPORT_DONT_MANGLE);
        if (should_mangle) {
            to_mangle.push(symbol);
        }
    }
});

AST_Toplevel.DEFMETHOD("find_colliding_names", function(options) {
    const cache = options.cache && options.cache.props;
    const avoid = new Set();
    options.reserved.forEach(to_avoid);
    this.globals.forEach(add_def);
    this.walk(new TreeWalker(function(node) {
        if (node instanceof AST_Scope) node.variables.forEach(add_def);
        if (node instanceof AST_SymbolCatch) add_def(node.definition());
    }));
    return avoid;

    function to_avoid(name) {
        avoid.add(name);
    }

    function add_def(def) {
        var name = def.name;
        if (def.global && cache && cache.has(name)) name = cache.get(name);
        else if (!def.unmangleable(options)) return;
        to_avoid(name);
    }
});

AST_Toplevel.DEFMETHOD("expand_names", function(options) {
    base54.reset();
    base54.sort();
    options = this._default_mangler_options(options);
    var avoid = this.find_colliding_names(options);
    var cname = 0;
    this.globals.forEach(rename);
    this.walk(new TreeWalker(function(node) {
        if (node instanceof AST_Scope) node.variables.forEach(rename);
        if (node instanceof AST_SymbolCatch) rename(node.definition());
    }));

    function next_name() {
        var name;
        do {
            name = base54(cname++);
        } while (avoid.has(name) || RESERVED_WORDS.has(name));
        return name;
    }

    function rename(def) {
        if (def.global && options.cache) return;
        if (def.unmangleable(options)) return;
        if (options.reserved.has(def.name)) return;
        const redefinition = redefined_catch_def(def);
        const name = def.name = redefinition ? redefinition.name : next_name();
        def.orig.forEach(function(sym) {
            sym.name = name;
        });
        def.references.forEach(function(sym) {
            sym.name = name;
        });
    }
});

AST_Node.DEFMETHOD("tail_node", return_this);
AST_Sequence.DEFMETHOD("tail_node", function() {
    return this.expressions[this.expressions.length - 1];
});

AST_Toplevel.DEFMETHOD("compute_char_frequency", function(options) {
    options = this._default_mangler_options(options);
    try {
        AST_Node.prototype.print = function(stream, force_parens) {
            this._print(stream, force_parens);
            if (this instanceof AST_Symbol && !this.unmangleable(options)) {
                base54.consider(this.name, -1);
            } else if (options.properties) {
                if (this instanceof AST_Dot) {
                    base54.consider(this.property, -1);
                } else if (this instanceof AST_Sub) {
                    skip_string(this.property);
                }
            }
        };
        base54.consider(this.print_to_string(), 1);
    } finally {
        AST_Node.prototype.print = AST_Node.prototype._print;
    }
    base54.sort();

    function skip_string(node) {
        if (node instanceof AST_String) {
            base54.consider(node.value, -1);
        } else if (node instanceof AST_Conditional) {
            skip_string(node.consequent);
            skip_string(node.alternative);
        } else if (node instanceof AST_Sequence) {
            skip_string(node.tail_node());
        }
    }
});

const base54 = (() => {
    const leading = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ$_".split("");
    const digits = "0123456789".split("");
    let chars;
    let frequency;
    function reset() {
        frequency = new Map();
        leading.forEach(function(ch) {
            frequency.set(ch, 0);
        });
        digits.forEach(function(ch) {
            frequency.set(ch, 0);
        });
    }
    base54.consider = function(str, delta) {
        for (var i = str.length; --i >= 0;) {
            frequency.set(str[i], frequency.get(str[i]) + delta);
        }
    };
    function compare(a, b) {
        return frequency.get(b) - frequency.get(a);
    }
    base54.sort = function() {
        chars = mergeSort(leading, compare).concat(mergeSort(digits, compare));
    };
    base54.reset = reset;
    reset();
    function base54(num) {
        var ret = "", base = 54;
        num++;
        do {
            num--;
            ret += chars[num % base];
            num = Math.floor(num / base);
            base = 64;
        } while (num > 0);
        return ret;
    }
    return base54;
})();

export {
    base54,
    SymbolDef,
};
