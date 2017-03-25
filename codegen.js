const { FormattedCodeGen, Sep, Paren } = require("shift-codegen");
const { TokenStream } = require("shift-codegen/dist/token_stream");
const shiftFuzzer = require("shift-fuzzer");
const shiftReducer = require("shift-reducer");
const random = require("./random");

// Hack: `tokenStrings` consisting of this invalid sequence of characters
// signify a whitespace token that cannot contain newlines.
const NO_NEWLINE = "}[)";

const LEADING_NEWLINE = /^(?!.)\s/;
const NON_ASI_LINE_START = /^[([+\-*/`]/;
const WHITESPACE = /^\s+$/;

const PARENTHESES_WRAPPABLE_METHOD = /^reduce.*Expression$/;

function randomTimes() {
  return random.item([1, 1, 1, 1, 2, 2, 3]);
}

class CustomTokenStream extends TokenStream {
  constructor({ comments = false, whitespace = false } = {}) {
    super();
    this._options = { comments, whitespace };
    this._probabilities = {
      comments: Math.random(),
      whitespace: Math.random(),
      semicolons: Math.random()
    };
    this._isASI = false;
  }

  put(tokenString, isRegExp) {
    const { optionalSemi } = this;

    // Sometimes print semicolons, sometimes newlines.
    if (optionalSemi) {
      this.optionalSemi = false;
      if (Math.random() < this._probabilities.semicolons) {
        this._isASI = true;
        super.put(random.lineTerminator());
      } else {
        this._isASI = false;
        super.put(";");
      }
    }

    // Add semicolons for lines starting with one of the characters where ASI
    // doesn’t kick in.
    if (this._isASI && NON_ASI_LINE_START.test(tokenString)) {
      this._isASI = false;
      super.put(";");
    }

    if (WHITESPACE.test(tokenString) || tokenString === NO_NEWLINE) {
      const allowNewlines = tokenString !== NO_NEWLINE;
      let newTokenString = tokenString;
      let didRandomizeWhitespace = false;

      if (tokenString === NO_NEWLINE) {
        newTokenString = " ";
      }

      // Sometimes randomize whitespace.
      if (
        this._options.whitespace &&
        Math.random() < this._probabilities.whitespace
      ) {
        const choices = allowNewlines
          ? [
              random.whitespace,
              () => random.lineTerminator().repeat(random.int(1, 2))
            ]
          : [random.whitespace];
        newTokenString = random.string(randomTimes(), () =>
          random.item(choices)());
        didRandomizeWhitespace = true;
      }

      // Sometimes randomize comments.
      if (
        this._options.comments && Math.random() < this._probabilities.comments
      ) {
        newTokenString = random.insertComments(newTokenString, {
          times: randomTimes(),
          allowNewlines
        });
      }

      if (newTokenString === "") {
        newTokenString = " ";
      }

      // If we just printed a newline instead of a semicolon, and didn’t change
      // the original whitespace, strip away the leading newline (if any) from
      // this chunk of whitespace, to avoid ending up with double newlines.
      if (optionalSemi && this._isASI && !didRandomizeWhitespace) {
        newTokenString = newTokenString.replace(LEADING_NEWLINE, "");
      }

      super.put(newTokenString);
      return;
    }

    this._isASI = optionalSemi;
    super.put(tokenString, isRegExp);
  }
}

class CustomFormattedCodeGen extends FormattedCodeGen {
  constructor(...args) {
    super(...args);
    this._probabilities = {
      parentheses: Math.random()
    };
  }

  // Track whether a sequence of whitespace can contain newlines or not.
  sep(separator) {
    switch (separator.type) {
      case "BEFORE_ARROW":
      case "BEFORE_POSTFIX":
      case "BEFORE_JUMP_LABEL":
      case "RETURN":
      case "THROW":
      case "YIELD":
        return this.t(NO_NEWLINE);
      default:
        return super.sep(separator);
    }
  }

  // Remove parentheses in `const obj = {(a)}`;
  reduceObjectExpression(node, data) {
    const { properties } = data;
    const newProperties = properties.map(removeParentheses);
    const newData = Object.assign({}, data, { properties: newProperties });
    return super.reduceObjectExpression(node, newData);
  }

  // Remove parentheses in `export {(a)}`;
  reduceExportLocalSpecifier(node, data) {
    const { name } = data;
    const newName = removeParentheses(name);
    const newData = Object.assign({}, data, { name: newName });
    return super.reduceExportLocalSpecifier(node, newData);
  }
}

function removeParentheses(node) {
  return node instanceof Paren
    ? removeParentheses(node.expr.children[1])
    : node;
}

const parenthesesAddingHandler = {
  get(target, property) {
    // Sometimes add extra parentheses.
    if (
      PARENTHESES_WRAPPABLE_METHOD.test(property) &&
      Math.random() < target._probabilities.parentheses
    ) {
      return (...args) => {
        const times = randomTimes();
        let node = target[property](...args);
        for (let i = 0; i < times; i++) {
          node = target.paren(
            node,
            Sep.EXPRESSION_PAREN_BEFORE,
            Sep.EXPRESSION_PAREN_AFTER
          );
        }
        return node;
      };
    }

    return target[property];
  }
};

function codeGen(ast, options = {}) {
  const generator = new CustomFormattedCodeGen();
  const proxiedGenerator = new Proxy(generator, parenthesesAddingHandler);
  const tokenStream = new CustomTokenStream(options);
  const rep = shiftReducer.default(proxiedGenerator, ast);
  rep.emit(tokenStream);
  return tokenStream.result;
}

function generateRandomJS(options = {}) {
  const fuzzer = options.sourceType === "script"
    ? shiftFuzzer.fuzzScript
    : shiftFuzzer.fuzzModule;

  const randomAST = fuzzer(
    new shiftFuzzer.FuzzerState({
      maxDepth: options.maxDepth
    })
  );

  return codeGen(randomAST, {
    comments: options.comments,
    whitespace: options.whitespace
  });
}

module.exports = generateRandomJS;
