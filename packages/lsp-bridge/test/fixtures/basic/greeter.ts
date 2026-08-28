export function greet(name: string): string {
  return `Hello, ${name}!`;
}

export class Greeter {
  private greeting: string;

  constructor(greeting: string) {
    this.greeting = greeting;
  }

  sayHi(): string {
    return greet(this.greeting);
  }
}
