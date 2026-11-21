/**
 * 随机身份生成(纯函数):姓名 / 密码 / 生日。
 * 姓名库沿用现有 randomIdentity.js(多为游戏角色名);密码用 crypto 安全随机。
 * 密码末尾固定 A1! 强制满足大小写+数字+符号要求。
 */
import { randomInt } from 'node:crypto';

const FIRST_NAMES = [
    'Ingrid', 'Sona', 'Jane', 'Fiona', 'Alexandrina', 'Vina', 'Toru', 'Tylla', 'Chilchuck',
    'Powl', 'Anmail', 'Fischer', 'Iwona', 'Cellinia', 'Sonya', 'Ksenia', 'Harmolin',
    'Weiss', 'Rhea', 'Sakiko', 'Pepe', 'Viviana', 'Lessing', 'Shuo', 'Mlynar', 'Anthony', 'Isidore',
    'Enciodes', 'Xanthos', 'Nyamu', 'Nuada', 'Laios', 'Gustave', 'Shuhrat', 'Rosalind',
    'Anis', 'Kate', 'Isabelle', 'Ernesto', 'Rafaela', 'Alexsandr', 'Zofia', 'Kemar', 'Astesia',
    'Beatrix', 'Charlotte', 'Laurentina', 'Lappland', 'Hannah', 'Cheng', 'Randall', 'Shura', 'Patrician',
    'Yu', 'Shu', 'Lavinia', 'Rita', 'Maria', 'Zumama', 'Nian', 'Hoshiguma', 'Fernand',
    'Senshi', 'Secunda', 'Michael', 'Shana', 'Agni', 'William', 'Lola', 'Elias', 'Xisheng',
    'Margaret', 'Makayla', 'Rada', 'Matterhorn', 'Bokai', 'Melie', 'Trevor', 'Narantuya', 'Rayella',
    'Avdotya', 'Fiammetta', 'Justina', 'Eliza', 'Hildegard', 'Rosmontis', 'Natalya', 'Gordon', 'Juana',
    'Bridgit', 'Anna', 'Helena', 'Madeleine', 'Federico', 'Arianrhod', 'Airy', 'Kali',
    'Totter', 'Mina', 'Jessica', 'Aletta', 'Marcille', 'Yuxia', 'Franz', 'Susie',
    'Elliot', 'Dusk', 'Adele', 'Aroma', 'Heinz', 'Delphine', 'Simone', 'Elena', 'Rochelle',
    'Yar', 'Eleanor', 'Tomimi', 'Leonhardt', 'Zoya', 'Rebel', 'Tonia', 'Ragna', 'Aria', 'Jody',
    'Kaltsit', 'Liz', 'Qingping', 'Paskala', 'Harold', 'Zoe', 'Ningning',
    'Louisa', 'Grace', 'Ceylon', 'Olivia', 'Lena', 'Gavial', 'Nasti', 'Haruka',
    'Momoka', 'Serafina', 'Arturia', 'Ling', 'Gnosis', 'Lisa', 'Angelina',
    'Catherine', 'Heidi', 'Enya', 'Roberta', 'Eureka', 'Lyudmila', 'Elzbieta', 'Dorothy', 'Lucian',
    'Mutsumi', 'Muriel', 'Luchino', 'Tina', 'Kirara', 'Claudia',
    'Alex', 'Misha', 'Talulah', 'Yelena', 'Sasha', 'Gray', 'Kristen', 'Rupert',
    'Otto', 'Andoain', 'Clement', 'Kohei', 'Amiya', 'Theresa',
];

const LAST_NAMES = [
    'Venezia', 'Bellone', 'Willow', 'Young', 'Victoria', 'Moriuchi', 'Timms', 'Fischer',
    'Dublinn', 'Texas', 'Markovna', 'Togawa', 'Sakhet', 'Hochberg',
    'Droste', 'Meyer', 'Nearl', 'Simon', 'SilverAsh', 'Gu', 'Chen', 'Kateb',
    'Visser', 'Morrigan', 'Montague', 'Salas', 'Silva', 'Senaviev', 'Swire', 'Saluzzo',
    'Jackson', 'Orlov', 'Falcone', 'Byrne', 'Wolfgang', 'Czerny',
    'Chunlei', 'Ivanova', 'Valentine', 'Cohen',
    'Columbo', 'Land', 'Grit', 'Grove',
    'Naumann', 'Rinaldi', 'Windermere', 'Rockwell', 'Gloria', 'Montblanc',
    'Shaw', 'Burris', 'Lin', 'Arizona', 'Silence', 'Moore',
    'Murasaki', 'Petrova', 'Edelweiss', 'Magellan', 'Misumi',
    'Fletcher', 'Thomson', 'Baker', 'Wegner', 'Bosak', 'Franks', 'Pena',
    'Wakaba', 'Booker', 'Meijer', 'Arias', 'Pastore', 'Tsang', 'Wan',
    'Wright', 'Dubois', 'Mifune',
];

const PASSWORD_CHARSET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$';

function pickRandom<T>(list: readonly T[]): T {
    return list[randomInt(list.length)]!;
}

export interface Identity {
    readonly fullName: string;
    readonly password: string;
    readonly age: number;
    /** ISO 日期 YYYY-MM-DD。 */
    readonly birthDate: string;
}

export function generateFullName(): string {
    return `${pickRandom(FIRST_NAMES)} ${pickRandom(LAST_NAMES)}`;
}

/** 生成密码:随机字符 + 固定后缀 A1!(保证满足大小写+数字+符号)。 */
export function generatePassword(length = 16): string {
    let pwd = '';
    for (let i = 0; i < length; i++) {
        pwd += PASSWORD_CHARSET[randomInt(PASSWORD_CHARSET.length)];
    }
    return `${pwd}A1!`;
}

/** 按 [ageMin, ageMax] 区间生成年龄与生日。 */
export function generateBirthDate(ageMin = 25, ageMax = 40): { age: number; birthDate: string } {
    const span = Math.max(1, ageMax - ageMin + 1);
    const age = ageMin + Math.floor(Math.random() * span);
    const year = new Date().getFullYear() - age;
    const month = 1 + Math.floor(Math.random() * 12);
    const day = 1 + Math.floor(Math.random() * 28);
    const birthDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return { age, birthDate };
}

/** 生成一组完整身份(姓名 + 密码 + 年龄 + 生日)。 */
export function generateIdentity(): Identity {
    const { age, birthDate } = generateBirthDate();
    return {
        fullName: generateFullName(),
        password: generatePassword(),
        age,
        birthDate,
    };
}
