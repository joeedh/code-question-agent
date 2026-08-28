import { greet, Greeter } from "./greeter.js";

const message = greet("world");
const greeter = new Greeter("friend");
const hi = greeter.sayHi();

console.log(message, hi);
