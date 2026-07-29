// Framework globals are implicit so parser parity stays provider-neutral.

function topLevelTarget(): void {}
function suiteTarget(): void {}
function caseTarget(): void {}
function helperTarget(): void {}

topLevelTarget();

describe("outer suite", () => {
  suiteTarget();

  it("duplicate case", () => {
    caseTarget();

    function nestedHelper(): void {
      helperTarget();
    }

    nestedHelper();
  });

  it("duplicate case", () => {
    caseTarget();
  });
});
