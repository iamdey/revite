/* eslint-disable react-hooks/rules-of-hooks */
import { Session } from "revolt-api/types/Auth";
import { Client } from "revolt.js";
import { Route } from "revolt.js/dist/api/routes";

import { createContext } from "preact";
import { useContext, useEffect, useMemo, useState } from "preact/hooks";

import { dispatch } from "../../redux";
import { connectState } from "../../redux/connector";
import { AuthState } from "../../redux/reducers/auth";

import Preloader from "../../components/ui/Preloader";

import { Children } from "../../types/Preact";
import { useIntermediate } from "../intermediate/Intermediate";
import { registerEvents, setReconnectDisallowed } from "./events";
import { takeError } from "./util";

export enum ClientStatus {
    INIT,
    LOADING,
    READY,
    OFFLINE,
    DISCONNECTED,
    CONNECTING,
    RECONNECTING,
    ONLINE,
}

export interface ClientOperations {
    login: (
        data: Route<"POST", "/auth/session/login">["data"],
    ) => Promise<void>;
    logout: (shouldRequest?: boolean) => Promise<void>;
    loggedIn: () => boolean;
    ready: () => boolean;
}

// By the time they are used, they should all be initialized.
// Currently the app does not render until a client is built and the other two are always initialized on first render.
// - insert's words
export const AppContext = createContext<Client>(null!);
export const StatusContext = createContext<ClientStatus>(null!);
export const OperationsContext = createContext<ClientOperations>(null!);

type Props = {
    auth: AuthState;
    children: Children;
};

function Context({ auth, children }: Props) {
    const { openScreen } = useIntermediate();
    const [status, setStatus] = useState(ClientStatus.INIT);
    const [client, setClient] = useState<Client>(
        undefined as unknown as Client,
    );

    useEffect(() => {
        (async () => {
            const client = new Client({
                autoReconnect: false,
                apiURL: import.meta.env.VITE_API_URL,
                debug: import.meta.env.DEV,
            });

            setClient(client);
            setStatus(ClientStatus.LOADING);
        })();
    }, []);

    if (status === ClientStatus.INIT) return null;

    const operations: ClientOperations = useMemo(() => {
        return {
            login: async (data) => {
                setReconnectDisallowed(true);

                try {
                    const onboarding = await client.login(data);
                    setReconnectDisallowed(false);
                    const login = () =>
                        dispatch({
                            type: "LOGIN",
                            session: client.session as Session,
                        });

                    if (onboarding) {
                        openScreen({
                            id: "onboarding",
                            callback: async (username: string) =>
                                onboarding(username, true).then(login),
                        });
                    } else {
                        login();
                    }
                } catch (err) {
                    setReconnectDisallowed(false);
                    throw err;
                }
            },
            logout: async (shouldRequest) => {
                dispatch({ type: "LOGOUT" });

                client.reset();
                dispatch({ type: "RESET" });

                openScreen({ id: "none" });
                setStatus(ClientStatus.READY);

                client.websocket.disconnect();

                if (shouldRequest) {
                    try {
                        await client.logout();
                    } catch (err) {
                        console.error(err);
                    }
                }
            },
            loggedIn: () => typeof auth.active !== "undefined",
            ready: () =>
                operations.loggedIn() && typeof client.user !== "undefined",
        };
    }, [client, auth.active, openScreen]);

    useEffect(
        () => registerEvents({ operations }, setStatus, client),
        [client, operations],
    );

    useEffect(() => {
        (async () => {
            if (auth.active) {
                dispatch({ type: "QUEUE_FAIL_ALL" });

                const active = auth.accounts[auth.active];
                client.user = client.users.get(active.session.user_id);
                if (!navigator.onLine) {
                    return setStatus(ClientStatus.OFFLINE);
                }

                if (operations.ready()) setStatus(ClientStatus.CONNECTING);

                if (navigator.onLine) {
                    await client
                        .fetchConfiguration()
                        .catch(() =>
                            console.error("Failed to connect to API server."),
                        );
                }

                try {
                    await client.fetchConfiguration();
                    const callback = await client.useExistingSession(
                        active.session,
                    );

                    if (callback) {
                        openScreen({ id: "onboarding", callback });
                    }
                } catch (err) {
                    setStatus(ClientStatus.DISCONNECTED);
                    const error = takeError(err);
                    if (error === "Forbidden" || error === "Unauthorized") {
                        operations.logout(true);
                        openScreen({ id: "signed_out" });
                    } else {
                        openScreen({ id: "error", error });
                    }
                }
            } else {
                try {
                    await client.fetchConfiguration();
                } catch (err) {
                    console.error("Failed to connect to API server.");
                }

                setStatus(ClientStatus.READY);
            }
        })();
        // eslint-disable-next-line
    }, []);

    if (status === ClientStatus.LOADING) {
        return <Preloader type="spinner" />;
    }

    return (
        <AppContext.Provider value={client}>
            <StatusContext.Provider value={status}>
                <OperationsContext.Provider value={operations}>
                    {children}
                </OperationsContext.Provider>
            </StatusContext.Provider>
        </AppContext.Provider>
    );
}

export default connectState<{ children: Children }>(Context, (state) => {
    return {
        auth: state.auth,
        sync: state.sync,
    };
});

export const useClient = () => useContext(AppContext);
