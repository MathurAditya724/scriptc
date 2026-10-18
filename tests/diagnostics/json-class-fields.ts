// JSON.stringify reads class instances through their checked-dynamic
// property view. A class whose declared field has no representation in
// that view is refused at compile time, naming the field.
class Schedule {
  name = "weekly";
  next = new Date(Date.UTC(2024, 0, 1));
}

class Calendar {
  title = "team";
  schedules: Schedule[] = [new Schedule()];
}

console.log(JSON.stringify(new Schedule()));
console.log(JSON.stringify({ calendar: new Calendar() }));
