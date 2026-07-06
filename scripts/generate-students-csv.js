import { faker } from '@faker-js/faker';
import fs from 'fs';

const TOTAL_STUDENTS = 70;

const branches = {
    BCS: 'Computer Science and Engineering',
    BEE: 'Electrical Engineering',
    BEC: 'Electronics and Communication Engineering',
    BME: 'Mechanical Engineering',
    BCE: 'Civil Engineering',
    BCH: 'Chemical Engineering',
    BPH: 'Engineering Physics',
    BMT: 'Material Science and Engineering'
};

const categories = [
    'GEN',
    'OBC',
    'SC',
    'ST',
    'EWS'
];

const bloodGroups = [
    'A+',
    'A-',
    'B+',
    'B-',
    'AB+',
    'AB-',
    'O+',
    'O-'
];

const rows = [];

rows.push([
    'Roll No',
    'Name of Student',
    'Father Name',
    'Mobile Number',
    'Parent Number',
    'Category',
    'Blood Group',
    'Department',
    'State',
    'Address',
    'Pincode'
].join(','));

let studentNumber = 122;

const branchCodes = Object.keys(branches);

for (let i = 0; i < TOTAL_STUDENTS; i++) {
    const branchCode =
        faker.helpers.arrayElement(branchCodes);

    const department =
        branches[branchCode];

    const rollNo =
        `27${branchCode}${String(studentNumber).padStart(4, '0')}`;

    const studentName =
        faker.person.fullName();

    const fatherName =
        faker.person.fullName({ sex: 'male' });

    const mobileNumber =
        faker.helpers.arrayElement(['9', '8', '7', '6']) +
        faker.string.numeric(9);

    const parentNumber =
        faker.helpers.arrayElement(['9', '8', '7', '6']) +
        faker.string.numeric(9);

    const category =
        faker.helpers.arrayElement(categories);

    const bloodGroup =
        faker.helpers.arrayElement(bloodGroups);

    const state =
        "Himachal Pradesh";

    const address =
        faker.location.streetAddress().replace(/,/g, ' ');

    const pincode =
        faker.string.numeric(6);

    rows.push([
        rollNo,
        `"${studentName}"`,
        `"${fatherName}"`,
        mobileNumber,
        parentNumber,
        category,
        bloodGroup,
        `"${department}"`,
        `"${state}"`,
        `"${address}"`,
        pincode
    ].join(','));

    studentNumber++;
}

fs.writeFileSync(
    'students.csv',
    rows.join('\n'),
    'utf8'
);

console.log(`Generated ${TOTAL_STUDENTS} students.`);
console.log('Output file: students.csv');