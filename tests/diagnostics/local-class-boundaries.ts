function privateBrand() { return class { #value = 1; read(): number { return this.#value; } }; }
function selfName() { return class Local { copy() { return new Local(); } }; }
class Base {}
function derived() { return class extends Base {}; }
function generic() { return class { read<T>(value: T): T { return value; } }; }
privateBrand();
selfName();
derived();
generic();
// End of unsupported local-class forms.
