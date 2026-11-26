package ru.softline.support.chat;

import static ru.softline.support.chat.ChatTypes.*;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpHeaders;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.ModelAttribute;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/manager/handoffs")
class ManagerController {
    private final ManagerAccess access;
    private final ManagerStore store;

    ManagerController(ManagerAccess access, ManagerStore store) {
        this.access = access;
        this.store = store;
    }

    @ModelAttribute
    void authorize(HttpServletRequest request, HttpServletResponse response) {
        response.setHeader(HttpHeaders.CACHE_CONTROL, "no-store");
        request.setAttribute("manager", access.requireManager(request.getHeader(HttpHeaders.AUTHORIZATION)));
    }

    @GetMapping
    List<QueueItem> list(@RequestAttribute("manager") String manager, @RequestParam(defaultValue = "50") int limit,
                        @RequestParam(defaultValue = "0") int offset) {
        if (limit < 1 || limit > 100 || offset < 0) throw ChatErrors.invalid();
        return store.list(manager, limit, offset);
    }

    @GetMapping("/{id}")
    AssignedHandoff read(@PathVariable UUID id, @RequestAttribute("manager") String manager) {
        return store.read(id, manager);
    }

    @PostMapping("/{id}/claim")
    QueueItem claim(@PathVariable UUID id, @RequestAttribute("manager") String manager) {
        return store.claim(id, manager);
    }

    @PostMapping("/{id}/messages")
    Message reply(@PathVariable UUID id, @RequestAttribute("manager") String manager, @RequestBody ManagerMessage input) {
        if (input.messageId() == null || input.text() == null || input.text().isBlank() || input.text().length() > 4_000) {
            throw ChatErrors.invalid();
        }
        return store.reply(id, manager, input);
    }

    @PostMapping("/{id}/resolve")
    QueueItem resolve(@PathVariable UUID id, @RequestAttribute("manager") String manager) {
        return store.resolve(id, manager);
    }
}
