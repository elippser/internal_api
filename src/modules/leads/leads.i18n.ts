/**
 * Los textos de los correos del alta, en los cinco idiomas de la plataforma.
 *
 * Viven en el API y no en el sitio porque el mail lo manda este servicio: para
 * cuando sale, el navegador que eligio el idioma ya no existe. El idioma viaja
 * en el lead (`locale`) desde el formulario y se resuelve aca.
 *
 * La forma la define `es`, igual que en el sitio publico: los otros cuatro se
 * declaran `EmailCopy`, asi que una clave faltante es un error de compilacion y
 * no un correo con un hueco.
 *
 * Los textos van CON tildes y con eñes. El correo se manda en UTF-8 declarado
 * (`charset=utf-8` en el head y el encoding que pone nodemailer), asi que no
 * hay nada que "romper" evitandolas: escribirlas mal es un error de ortografia
 * a la vista, no una precaucion tecnica.
 */

export const LOCALES = ["es", "en", "pt", "fr", "de"] as const;
export type Locale = (typeof LOCALES)[number];

/** Un `locale` cualquiera (o basura) reducido a uno de los cinco. */
export function resolveLocale(value: string | undefined | null): Locale {
  const short = (value ?? "").slice(0, 2).toLowerCase();
  return (LOCALES as readonly string[]).includes(short) ? (short as Locale) : "es";
}

const es = {
  invite: {
    subject: "Tu acceso para crear la cuenta de roombir",
    preheader: "El enlace es personal y de un solo uso.",
    eyebrow: "Acceso al alta",
    title: "Ya podés crear tu cuenta",
    greet: "Hola,",
    greetNamed: (name: string) => `Hola ${name},`,
    body: (hotel: string) =>
      `Recibimos los datos de ${hotel}. Este botón abre el alta con tu correo ya cargado: solo te queda elegir una contraseña.`,
    bodyText: (hotel: string) =>
      `Recibimos los datos de ${hotel}. Abrí este enlace para crear tu cuenta:`,
    cta: "Crear mi cuenta",
    fallback: "Si el botón no funciona, copiá y pegá esta dirección en el navegador:",
    stepsTitle: "Cómo sigue",
    steps: [
      "Elegís una contraseña y entrás.",
      "Cargás tu empresa y tu alojamiento.",
      "El asistente arma tu espacio de trabajo.",
    ],
    expiry: (days: number, date: string) =>
      `El enlace vence el ${date}, en ${days} ${days === 1 ? "día" : "días"}, y se puede usar una sola vez.`,
    ignore: "Si no pediste esto, ignorá el mensaje: sin este enlace no se crea ninguna cuenta.",
    footer: "Roombir — el sistema operativo de tu alojamiento",
  },
  existing: {
    subject: "Ya tenés una cuenta en roombir",
    preheader: "Entrá con tu correo de siempre.",
    title: "Esa dirección ya tiene cuenta",
    body: "Pediste acceso con un correo que ya está registrado. No hace falta crear nada nuevo: entrá con el mismo correo.",
    cta: "Ingresar",
    forgot: "Si no recordás la contraseña, usá la opción de recuperarla en la pantalla de ingreso.",
  },
};

export type EmailCopy = typeof es;

const en: EmailCopy = {
  invite: {
    subject: "Your access to create your Roombir account",
    preheader: "This link is personal and works once.",
    eyebrow: "Sign-up access",
    title: "You can create your account now",
    greet: "Hi,",
    greetNamed: (name: string) => `Hi ${name},`,
    body: (hotel: string) =>
      `We got the details for ${hotel}. This button opens the sign-up with your email already filled in — all that is left is choosing a password.`,
    bodyText: (hotel: string) =>
      `We got the details for ${hotel}. Open this link to create your account:`,
    cta: "Create my account",
    fallback: "If the button does not work, copy and paste this address into your browser:",
    stepsTitle: "What happens next",
    steps: [
      "You choose a password and sign in.",
      "You add your company and your property.",
      "The assistant sets up your workspace.",
    ],
    expiry: (days: number, date: string) =>
      `The link expires on ${date}, in ${days} ${days === 1 ? "day" : "days"}, and can only be used once.`,
    ignore:
      "If you did not ask for this, ignore the message: no account is created without this link.",
    footer: "Roombir — the operating system for your property",
  },
  existing: {
    subject: "You already have a Roombir account",
    preheader: "Sign in with the email you already use.",
    title: "That address already has an account",
    body: "You asked for access with an email that is already registered. There is nothing to create: sign in with the same email.",
    cta: "Sign in",
    forgot: "If you do not remember the password, use the recover option on the sign-in screen.",
  },
};

const pt: EmailCopy = {
  invite: {
    subject: "Seu acesso para criar a conta no roombir",
    preheader: "O link é pessoal e de uso único.",
    eyebrow: "Acesso ao cadastro",
    title: "Já pode criar sua conta",
    greet: "Olá,",
    greetNamed: (name: string) => `Olá ${name},`,
    body: (hotel: string) =>
      `Recebemos os dados de ${hotel}. Este botão abre o cadastro com seu e-mail já preenchido: falta só escolher uma senha.`,
    bodyText: (hotel: string) =>
      `Recebemos os dados de ${hotel}. Abra este link para criar sua conta:`,
    cta: "Criar minha conta",
    fallback: "Se o botão não funcionar, copie e cole este endereço no navegador:",
    stepsTitle: "Como continua",
    steps: [
      "Você escolhe uma senha e entra.",
      "Cadastra sua empresa e sua hospedagem.",
      "O assistente monta seu espaço de trabalho.",
    ],
    expiry: (days: number, date: string) =>
      `O link vence em ${date}, daqui a ${days} ${days === 1 ? "dia" : "dias"}, e pode ser usado uma única vez.`,
    ignore:
      "Se você não pediu isto, ignore a mensagem: sem este link nenhuma conta é criada.",
    footer: "Roombir — o sistema operacional da sua hospedagem",
  },
  existing: {
    subject: "Você já tem uma conta no roombir",
    preheader: "Entre com o e-mail de sempre.",
    title: "Esse endereço já tem conta",
    body: "Você pediu acesso com um e-mail que já está cadastrado. Não precisa criar nada: entre com o mesmo e-mail.",
    cta: "Entrar",
    forgot: "Se não lembra a senha, use a opção de recuperar na tela de entrada.",
  },
};

const fr: EmailCopy = {
  invite: {
    subject: "Votre accès pour créer votre compte roombir",
    preheader: "Ce lien est personnel et à usage unique.",
    eyebrow: "Accès à l’inscription",
    title: "Vous pouvez créer votre compte",
    greet: "Bonjour,",
    greetNamed: (name: string) => `Bonjour ${name},`,
    body: (hotel: string) =>
      `Nous avons reçu les informations de ${hotel}. Ce bouton ouvre l’inscription avec votre e-mail déjà rempli : il ne reste qu’à choisir un mot de passe.`,
    bodyText: (hotel: string) =>
      `Nous avons reçu les informations de ${hotel}. Ouvrez ce lien pour créer votre compte :`,
    cta: "Créer mon compte",
    fallback: "Si le bouton ne fonctionne pas, copiez cette adresse dans votre navigateur :",
    stepsTitle: "La suite",
    steps: [
      "Vous choisissez un mot de passe et vous vous connectez.",
      "Vous ajoutez votre société et votre hébergement.",
      "L’assistant prépare votre espace de travail.",
    ],
    expiry: (days: number, date: string) =>
      `Le lien expire le ${date}, dans ${days} ${days === 1 ? "jour" : "jours"}, et ne peut servir qu’une fois.`,
    ignore:
      "Si vous n’avez rien demandé, ignorez ce message : aucun compte n’est créé sans ce lien.",
    footer: "Roombir — le système d’exploitation de votre hébergement",
  },
  existing: {
    subject: "Vous avez déjà un compte roombir",
    preheader: "Connectez-vous avec votre e-mail habituel.",
    title: "Cette adresse a déjà un compte",
    body: "Vous avez demandé un accès avec un e-mail déjà enregistré. Rien à créer : connectez-vous avec le même e-mail.",
    cta: "Se connecter",
    forgot:
      "Si vous avez oublié le mot de passe, utilisez l’option de récupération sur l’écran de connexion.",
  },
};

const de: EmailCopy = {
  invite: {
    subject: "Ihr Zugang zum roombir-Konto",
    preheader: "Der Link ist persönlich und nur einmal gültig.",
    eyebrow: "Zugang zur Anmeldung",
    title: "Sie können Ihr Konto jetzt anlegen",
    greet: "Hallo,",
    greetNamed: (name: string) => `Hallo ${name},`,
    body: (hotel: string) =>
      `Wir haben die Daten von ${hotel} erhalten. Dieser Button öffnet die Anmeldung mit Ihrer bereits eingetragenen E-Mail — es fehlt nur noch ein Passwort.`,
    bodyText: (hotel: string) =>
      `Wir haben die Daten von ${hotel} erhalten. Öffnen Sie diesen Link, um Ihr Konto anzulegen:`,
    cta: "Konto anlegen",
    fallback: "Falls der Button nicht funktioniert, kopieren Sie diese Adresse in den Browser:",
    stepsTitle: "So geht es weiter",
    steps: [
      "Sie wählen ein Passwort und melden sich an.",
      "Sie legen Ihr Unternehmen und Ihre Unterkunft an.",
      "Der Assistent richtet Ihren Arbeitsbereich ein.",
    ],
    expiry: (days: number, date: string) =>
      `Der Link läuft am ${date} ab, in ${days} ${days === 1 ? "Tag" : "Tagen"}, und ist nur einmal verwendbar.`,
    ignore:
      "Wenn Sie das nicht angefordert haben, ignorieren Sie die Nachricht: ohne diesen Link entsteht kein Konto.",
    footer: "Roombir — das Betriebssystem Ihrer Unterkunft",
  },
  existing: {
    subject: "Sie haben bereits ein roombir-Konto",
    preheader: "Melden Sie sich mit Ihrer gewohnten E-Mail an.",
    title: "Diese Adresse hat bereits ein Konto",
    body: "Sie haben Zugang mit einer E-Mail angefragt, die schon registriert ist. Es muss nichts angelegt werden: melden Sie sich mit derselben E-Mail an.",
    cta: "Anmelden",
    forgot:
      "Wenn Sie das Passwort vergessen haben, nutzen Sie die Wiederherstellung auf der Anmeldeseite.",
  },
};

const DICT: Record<Locale, EmailCopy> = { es, en, pt, fr, de };

export function emailCopy(locale: Locale): EmailCopy {
  return DICT[locale];
}
