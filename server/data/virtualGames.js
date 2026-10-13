// Virtual games catalogue (the same 21 games SofaBets lists on its Virtual page).
// img = path of the artwork on sofabets.com (fetched once by the server and cached in memory).
const K = (ref, img, name, extra) => Object.assign({ provider: 'kiron', ref, img: '/games/kiron/' + img, name }, extra || {});
const P = (ref, img, name) => ({ provider: 'pascal', ref, img: '/pascal/' + img, name });

module.exports = [
  K('DEHAO', 'virtual-league.webp', 'Virtual League', { hot: true }),
  K('9FQWB', 'virtual-world-cup.webp', 'Virtual World Cup'),
  K('EHU9Z', 'virtual-jackpot.webp', 'Virtual Jackpot'),
  K('CB6KF', 'pick-a-box.webp', 'Pick A Box'),
  K('LDS9J', 'turbo-league.webp', 'Turbo League'),
  K('ADWBJ', 'virtual-champions-league.webp', 'Virtual Champions League'),
  P('4000215', '4000215.jpg', 'Virtual Soccer'),
  P('426636733', '426636733.png', 'Virtual Soccer 3D'),
  P('4000508', '4000508.png', 'Virtual Football'),
  P('3200', '3200.png', 'Virtual Football League'),
  P('4000287', '4000287.png', 'Instant Football'),
  P('420018576', '420018576.gif', 'Football'),
  P('420018577', '420018577.gif', 'Football League'),
  P('4000210', '4000210.jpg', 'Virtual Champions'),
  P('3201', '3201.png', 'Virtual Penalty Kick'),
  P('3205', '3205.png', 'World League'),
  P('5000046', '5000046.jpg', 'Virtual Euro Trophy'),
  P('3203', '3203.png', 'Virtual Horse Racing'),
  P('4000237', '4000237.png', 'Instant Horses'),
  P('40004202', '40004202.jpg', 'Horses'),
  P('420018579', '420018579.gif', 'Horse Racing')
];
