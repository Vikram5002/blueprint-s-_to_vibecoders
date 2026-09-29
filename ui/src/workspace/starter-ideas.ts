/**
 * Ready-made requests for Agent mode: the projects students are most often
 * asked to build, each written the way a good request reads - who uses it and
 * what they can do - so a first run starts from a plan worth reviewing.
 * Clicking one only fills the box; nothing starts until "Build it".
 */
export interface StarterIdea {
  readonly label: string;
  readonly prompt: string;
}

export const STARTER_IDEAS: readonly StarterIdea[] = [
  {
    label: 'College fest website',
    prompt: 'A college fest website with event listings, online registration for each event, and an admin page to see who registered.',
  },
  {
    label: 'Library management',
    prompt: 'A library management system where students search books, issue and return them, and librarians manage the catalogue.',
  },
  {
    label: 'Attendance tracker',
    prompt: 'An attendance tracker where teachers mark daily attendance per class and students see their attendance percentage.',
  },
  {
    label: 'Hostel complaints',
    prompt: 'A hostel complaint portal where students raise complaints, wardens assign and resolve them, and students track the status.',
  },
  {
    label: 'Placement portal',
    prompt: 'A placement cell portal where companies post recruitment drives, students apply, and the cell tracks every application.',
  },
  {
    label: 'Online quiz',
    prompt: 'An online quiz app where teachers create quizzes with a time limit, and students take them and see their scores.',
  },
  {
    label: 'Food delivery',
    prompt: 'A food delivery site where customers order from restaurants, and restaurants register, manage their menu and deliver orders.',
  },
  {
    label: 'Portfolio',
    prompt: 'A personal portfolio site with my projects, skills, a short blog and a contact form that saves messages.',
  },
];
