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
    title: "Listo, ya podes crear tu cuenta",
    greet: "Hola,",
    greetNamed: (name: string) => `Hola ${name},`,
    body: (hotel: string) =>
      `Recibimos los datos de ${hotel}. Este boton abre el alta con tu correo ya cargado: solo te queda elegir una contrasena.`,
    bodyText: (hotel: string) =>
      `Recibimos los datos de ${hotel}. Abri este enlace para crear tu cuenta:`,
    cta: "Crear mi cuenta",
    fallback: "Si el boton no funciona, copia y pega esta direccion en el navegador:",
    expires: (days: number) =>
      `El enlace vence en ${days} ${days === 1 ? "dia" : "dias"} y se puede usar una sola vez.`,
    ignore: "Si no pediste esto, ignora el mensaje: sin este enlace no se crea ninguna cuenta.",
    footer: "Roombir - el sistema operativo de tu alojamiento",
  },
  existing: {
    subject: "Ya tenes una cuenta en roombir",
    preheader: "Entra con tu correo de siempre.",
    title: "Esa direccion ya tiene cuenta",
    body: "Pediste acceso con un correo que ya esta registrado. No hace falta crear nada nuevo: entra con el mismo correo.",
    cta: "Ingresar",
    forgot: "Si no recordas la contrasena, usa la opcion de recuperarla en la pantalla de ingreso.",
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
      `We got the details for ${hotel}. This button opens the sign-up with your email already filled in - all that is left is choosing a password.`,
    bodyText: (hotel: string) =>
      `We got the details for ${hotel}. Open this link to create your account:`,
    cta: "Create my account",
    fallback: "If the button does not work, copy and paste this address into your browser:",
    expires: (days: number) =>
      `The link expires in ${days} ${days === 1 ? "day" : "days"} and can only be used once.`,
    ignore: "If you did not ask for this, ignore the message: no account is created without this link.",
    footer: "Roombir - the operating system for your property",
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
    preheader: "O link e pessoal e de uso unico.",
    eyebrow: "Acesso ao cadastro",
    title: "Pronto, ja pode criar sua conta",
    greet: "Ola,",
    greetNamed: (name: string) => `Ola ${name},`,
    body: (hotel: string) =>
      `Recebemos os dados de ${hotel}. Este botao abre o cadastro com seu e-mail ja preenchido: falta so escolher uma senha.`,
    bodyText: (hotel: string) =>
      `Recebemos os dados de ${hotel}. Abra este link para criar sua conta:`,
    cta: "Criar minha conta",
    fallback: "Se o botao nao funcionar, copie e cole este endereco no navegador:",
    expires: (days: number) =>
      `O link vence em ${days} ${days === 1 ? "dia" : "dias"} e pode ser usado uma unica vez.`,
    ignore: "Se voce nao pediu isto, ignore a mensagem: sem este link nenhuma conta e criada.",
    footer: "Roombir - o sistema operacional da sua hospedagem",
  },
  existing: {
    subject: "Voce ja tem uma conta no roombir",
    preheader: "Entre com o e-mail de sempre.",
    title: "Esse endereco ja tem conta",
    body: "Voce pediu acesso com um e-mail que ja esta cadastrado. Nao precisa criar nada: entre com o mesmo e-mail.",
    cta: "Entrar",
    forgot: "Se nao lembra a senha, use a opcao de recuperar na tela de entrada.",
  },
};

const fr: EmailCopy = {
  invite: {
    subject: "Votre acces pour creer votre compte roombir",
    preheader: "Ce lien est personnel et a usage unique.",
    eyebrow: "Acces a l inscription",
    title: "Vous pouvez creer votre compte",
    greet: "Bonjour,",
    greetNamed: (name: string) => `Bonjour ${name},`,
    body: (hotel: string) =>
      `Nous avons recu les informations de ${hotel}. Ce bouton ouvre l inscription avec votre e-mail deja rempli : il ne reste qu a choisir un mot de passe.`,
    bodyText: (hotel: string) =>
      `Nous avons recu les informations de ${hotel}. Ouvrez ce lien pour creer votre compte :`,
    cta: "Creer mon compte",
    fallback: "Si le bouton ne fonctionne pas, copiez cette adresse dans votre navigateur :",
    expires: (days: number) =>
      `Le lien expire dans ${days} ${days === 1 ? "jour" : "jours"} et ne peut servir qu une fois.`,
    ignore: "Si vous n avez rien demande, ignorez ce message : aucun compte n est cree sans ce lien.",
    footer: "Roombir - le systeme d exploitation de votre hebergement",
  },
  existing: {
    subject: "Vous avez deja un compte roombir",
    preheader: "Connectez-vous avec votre e-mail habituel.",
    title: "Cette adresse a deja un compte",
    body: "Vous avez demande un acces avec un e-mail deja enregistre. Rien a creer : connectez-vous avec le meme e-mail.",
    cta: "Se connecter",
    forgot: "Si vous avez oublie le mot de passe, utilisez l option de recuperation sur l ecran de connexion.",
  },
};

const de: EmailCopy = {
  invite: {
    subject: "Ihr Zugang zum roombir-Konto",
    preheader: "Der Link ist personlich und nur einmal gultig.",
    eyebrow: "Zugang zur Anmeldung",
    title: "Sie konnen Ihr Konto jetzt anlegen",
    greet: "Hallo,",
    greetNamed: (name: string) => `Hallo ${name},`,
    body: (hotel: string) =>
      `Wir haben die Daten von ${hotel} erhalten. Dieser Button offnet die Anmeldung mit Ihrer bereits eingetragenen E-Mail - fehlt nur noch ein Passwort.`,
    bodyText: (hotel: string) =>
      `Wir haben die Daten von ${hotel} erhalten. Offnen Sie diesen Link, um Ihr Konto anzulegen:`,
    cta: "Konto anlegen",
    fallback: "Falls der Button nicht funktioniert, kopieren Sie diese Adresse in den Browser:",
    expires: (days: number) =>
      `Der Link lauft in ${days} ${days === 1 ? "Tag" : "Tagen"} ab und ist nur einmal verwendbar.`,
    ignore: "Wenn Sie das nicht angefordert haben, ignorieren Sie die Nachricht: ohne diesen Link entsteht kein Konto.",
    footer: "Roombir - das Betriebssystem Ihrer Unterkunft",
  },
  existing: {
    subject: "Sie haben bereits ein roombir-Konto",
    preheader: "Melden Sie sich mit Ihrer gewohnten E-Mail an.",
    title: "Diese Adresse hat bereits ein Konto",
    body: "Sie haben Zugang mit einer E-Mail angefragt, die schon registriert ist. Es muss nichts angelegt werden: melden Sie sich mit derselben E-Mail an.",
    cta: "Anmelden",
    forgot: "Wenn Sie das Passwort vergessen haben, nutzen Sie die Wiederherstellung auf der Anmeldeseite.",
  },
};

const DICT: Record<Locale, EmailCopy> = { es, en, pt, fr, de };

export function emailCopy(locale: Locale): EmailCopy {
  return DICT[locale];
}
